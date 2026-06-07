const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const appId = process.env.APP_ID || 'mysaceng';
const projectId = process.env.FIREBASE_PROJECT_ID || 'sppsmkcengkareng2';

// Menggunakan URL Cloud Production asia-southeast2 secara default
const DATA_CONNECT_ENDPOINT = process.env.DATA_CONNECT_ENDPOINT || 
  `https://firebasedataconnect.googleapis.com/v1beta/projects/${projectId}/locations/asia-southeast2/services/${appId}-service:executeGraphQL`;

app.use(cors({
  origin: [
    'https://sppsmkcengkareng2.web.app', 
    'https://sppsmkcengkareng2.firebaseapp.com', 
    'http://localhost:5000', 
    'http://127.0.0.1:5000'
  ],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Inisialisasi Firebase Admin untuk fallback NoSQL realtime sync secara aman
function initFirebaseAdmin() {
  if (admin.apps.length > 0) {
    return admin.apps[0].firestore();
  }

  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      let rawServiceAccount = process.env.FIREBASE_SERVICE_ACCOUNT.trim();
      if (rawServiceAccount.includes('\\n')) {
        rawServiceAccount = rawServiceAccount.replace(/\\n/g, '\n');
      }
      const serviceAccount = JSON.parse(rawServiceAccount);
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
      console.log("✓ Firebase Admin SDK berhasil diinisialisasi.");
      return admin.firestore();
    } catch (err) {
      console.error("✗ Gagal menginisialisasi Firebase Admin SDK:", err.message);
    }
  } else {
    console.warn("⚠ FIREBASE_SERVICE_ACCOUNT tidak ditemukan di Environment Variables.");
  }
  return null;
}

const db = initFirebaseAdmin();

// Helper aman untuk eksekusi query/mutation ke Firebase Data Connect
async function executeDataConnect(operationName, query, variables = {}) {
  try {
    const response = await axios.post(DATA_CONNECT_ENDPOINT, {
      query: query,
      operationName: operationName,
      variables: variables
    }, {
      headers: {
        'Content-Type': 'application/json'
      }
    });

    if (response.data.errors) {
      console.error(`✗ Gagal eksekusi Data Connect [${operationName}]:`, JSON.stringify(response.data.errors, null, 2));
      throw new Error(response.data.errors[0].message);
    }
    return response.data.data;
  } catch (error) {
    console.error(`✗ Network Error pada Data Connect [${operationName}]:`, error.message);
    throw error;
  }
}

// Inisialisasi Midtrans Snap Client dengan proteksi fallback
const serverKey = process.env.MIDTRANS_SERVER_KEY;
if (!serverKey) {
  console.warn("⚠ Peringatan: MIDTRANS_SERVER_KEY tidak dikonfigurasi di Environment Variables!");
}

const snap = new midtransClient.Snap({
  isProduction: false, // Sandbox mode
  serverKey: serverKey || ""
});

// Endpoint dasar untuk cek konektivitas backend
app.get('/healthz', (req, res) => {
  res.status(200).json({ status: 'running', message: 'Backend MySaceng Active & Integrated with Cloud SQL Data Connect' });
});

// 1. ENDPOINT: MEMBUAT TRANSAKSI / TOKEN SNAP MIDTRANS
app.post('/api/payment/token', async (req, res) => {
  try {
    let { nisn, nama, email, listTagihan, totalBayar, item, amount, index, type } = req.body;

    if (!serverKey || serverKey === "") {
        return res.status(500).json({ error: "Konfigurasi server key Midtrans di Server/Vercel belum dikonfigurasi." });
    }

    // Jembatan Kompatibilitas: Konversi dinamis jika menerima request format lama
    if (!listTagihan && item && amount) {
      const idxNum = index !== undefined ? index : 0;
      const typeStr = type || 'spp';
      listTagihan = [{
        idTagihan: typeStr === 'spp' ? `spp-tagihan-${idxNum}-${nisn}` : `other-tagihan-${idxNum}-${nisn}`,
        namaTagihan: item,
        jumlahNominal: amount
      }];
      totalBayar = amount;
    }

    if (!nisn || !listTagihan || listTagihan.length === 0 || !totalBayar) {
      return res.status(400).json({ error: 'Data pembayaran tidak lengkap!' });
    }

    const orderId = `INV-SPP-${Date.now()}-${nisn}`;
    const cleanEmail = email || `${nisn}@student.smkcengkareng2.sch.id`;
    const tagihanIdsString = listTagihan.map(t => t.idTagihan).join(',');

    const itemDetails = listTagihan.map(t => ({
      id: t.idTagihan,
      price: parseInt(t.jumlahNominal),
      quantity: 1,
      name: t.namaTagihan.substring(0, 50)
    }));

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: parseInt(totalBayar)
      },
      customer_details: {
        first_name: nama,
        email: cleanEmail,
        phone: '08123456789'
      },
      item_details: itemDetails,
      custom_field1: tagihanIdsString,
      callbacks: {
        finish: "https://sppsmkcengkareng2.web.app/?payment_status=success"
      },
      expiry: {
        start_time: getFormattedCurrentDateTimeMidtrans(),
        unit: 'minutes',
        duration: 120
      }
    };

    const transaction = await snap.createTransaction(parameter);
    
    res.status(200).json({
      token: transaction.token,
      redirect_url: transaction.redirect_url,
      orderId: orderId
    });
  } catch (error) {
    console.error("✗ Gagal membuat Snap Token Midtrans:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. ENDPOINT: WEBHOOK NOTIFIKASI MIDTRANS
app.post('/api/payment/notification', async (req, res) => {
  try {
    const statusResponse = req.body;
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;
    const paymentType = statusResponse.payment_type;
    const grossAmount = statusResponse.gross_amount;
    const customField1 = statusResponse.custom_field1;

    console.log(`⚡ Menerima Webhook Midtrans: OrderID ${orderId} | Status: ${transactionStatus}`);

    const orderParts = orderId.split('-');
    const nisn = orderParts[orderParts.length - 1];

    if (transactionStatus === 'settlement' || transactionStatus === 'capture') {
      if (fraudStatus === 'accept' || transactionStatus === 'settlement') {
        
        const dateStr = getFormattedCurrentDateTime();
        const cleanMethod = paymentType ? paymentType.toUpperCase().replace('_', ' ') : 'MIDTRANS';
        const itemTitle = "Pelunasan Pembayaran Online via Portal";

        // A. INTEGRASI KE CLOUD SQL VIA FIREBASE DATA CONNECT (PostgreSQL)
        const sqlCatatTransaksi = `
          mutation CatatTransaksiLog($idTransaksi: String!, $siswaNisn: String!, $staffUsername: String, $namaItemPembayaran: String!, $jumlahDiterima: Int!, $tanggalWaktuBayar: String!, $metodePembayaran: String!, $waktuSistemUnix: Int64!) {
            transaksi_insert(data: {
              idTransaksi: $idTransaksi,
              siswa: { nisn: $siswaNisn },
              pencatatStaff: { usernameStaff: $staffUsername },
              namaItemPembayaran: $namaItemPembayaran,
              jumlahDiterima: $jumlahDiterima,
              tanggalWaktuBayar: $tanggalWaktuBayar,
              metodePembayaran: $metodePembayaran,
              waktuSistemUnix: $waktuSistemUnix
            })
          }
        `;

        try {
          await executeDataConnect('CatatTransaksiLog', sqlCatatTransaksi, {
            idTransaksi: orderId,
            siswaNisn: nisn,
            staffUsername: null,
            namaItemPembayaran: itemTitle,
            jumlahDiterima: parseInt(grossAmount),
            tanggalWaktuBayar: dateStr,
            metodePembayaran: cleanMethod,
            waktuSistemUnix: Date.now()
          });
          console.log(`✓ [PostgreSQL Cloud SQL] Log transaksi ${orderId} sukses dicatat.`);
        } catch (sqlErr) {
          console.error("✗ Gagal menyisipkan log transaksi ke PostgreSQL: ", sqlErr.message);
        }

        if (customField1) {
          const listIdTagihan = customField1.split(',');
          
          const sqlLunasiTagihan = `
            mutation LunasiTagihanSiswa($idTagihan: UUID!, $statusPembayaran: String!, $tanggalPelunasan: String, $nomorReferensiTransaksi: String) {
              tagihan_update(
                key: { idTagihan: $idTagihan },
                data: {
                  statusPembayaran: $statusPembayaran,
                  tanggalPelunasan: $tanggalPelunasan,
                  nomorReferensiTransaksi: $nomorReferensiTransaksi
                }
              )
            }
          `;

          for (const idTagihan of listIdTagihan) {
            if (idTagihan.trim()) {
              try {
                await executeDataConnect('LunasiTagihanSiswa', sqlLunasiTagihan, {
                  idTagihan: idTagihan.trim(),
                  statusPembayaran: "Lunas",
                  tanggalPelunasan: dateStr,
                  nomorReferensiTransaksi: orderId
                });
                console.log(`✓ [PostgreSQL Cloud SQL] Tagihan ${idTagihan} berhasil dilunasi.`);
              } catch (sqlTagihanErr) {
                console.error(`✗ Gagal melunasi tagihan SQL ${idTagihan}: `, sqlTagihanErr.message);
              }
            }
          }
        }

        // B. SINKRONISASI FIRESTORE DENGAN SAFETY-CHECK JIKA DB OFFLINE / NULL
        if (db) {
          try {
            const transRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('transactions').doc(orderId);
            await transRef.set({
              idTransaksi: orderId,
              nisn: nisn,
              namaItemPembayaran: itemTitle,
              jumlahDiterima: parseInt(grossAmount),
              tanggalWaktuBayar: dateStr,
              metodePembayaran: cleanMethod,
              waktuSistemUnix: Date.now()
            });

            if (customField1) {
              const listIdTagihan = customField1.split(',');
              for (const idTagihan of listIdTagihan) {
                const studentRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('students').doc(nisn);
                const docSnap = await studentRef.get();
                if (docSnap.exists) {
                  const studentData = docSnap.data();
                  let updatedSpp = studentData.sppMonths ? [...studentData.sppMonths] : [];
                  let updatedNonSpp = studentData.nonSppTagihan ? [...studentData.nonSppTagihan] : [];
                  let updatedHistory = studentData.history ? [...studentData.history] : [];

                  const sppIdx = updatedSpp.findIndex(m => idTagihan.includes(m.m) || idTagihan.includes(m.m.replace(' ', '')));
                  if (sppIdx !== -1) {
                    updatedSpp[sppIdx].s = "Lunas";
                    updatedSpp[sppIdx].date = dateStr;
                    updatedSpp[sppIdx].ref = `${orderId} - ${cleanMethod}`;
                  } else {
                    const otherIdx = updatedNonSpp.findIndex(t => idTagihan.includes(t.name.replace(' ', '')));
                    if (otherIdx !== -1) {
                      updatedNonSpp[otherIdx].status = "Lunas";
                    }
                  }

                  const isHistoryExist = updatedHistory.some(h => h.id === orderId);
                  if (!isHistoryExist) {
                    updatedHistory.unshift({
                      id: orderId,
                      title: itemTitle,
                      amount: parseInt(grossAmount).toLocaleString('id-ID'),
                      date: dateStr,
                      status: `LUNAS - ${cleanMethod}`
                    });
                  }

                  await studentRef.update({
                    sppMonths: updatedSpp,
                    nonSppTagihan: updatedNonSpp,
                    history: updatedHistory
                  });
                }
              }
            }
            console.log(`✓ [Firestore Fallback] Realtime synchronization sukses.`);
          } catch (fsError) {
            console.error("⚠ [Firestore Fallback] Gagal sinkronisasi realtime, namun data utama di PostgreSQL tetap aman:", fsError.message);
          }
        }
      }
    }

    res.status(200).send('Notification processed successfully');
  } catch (error) {
    console.error("✗ Gagal memproses Webhook Midtrans:", error);
    res.status(500).json({ error: error.message });
  }
});

// HELPER FORMAT WAKTU
function getFormattedCurrentDateTime() {
  const now = new Date();
  const date = String(now.getDate()).padStart(2, '0');
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const hrs = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  return `${date} ${months[now.getMonth()]} ${now.getFullYear()}, ${hrs}:${mins}`;
}

function getFormattedCurrentDateTimeMidtrans() {
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd} ${hh}:${min}:${ss} +0700`;
}

app.listen(PORT, () => {
  console.log(`✓ Server MySaceng Backend berjalan di port ${PORT}`);
});