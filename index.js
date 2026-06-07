const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const admin = require('firebase-admin');
const axios = require('axios');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const appId = process.env.APP_ID || 'mysaceng';

// Firebase Data Connect Endpoint & Config dari env
const DATA_CONNECT_ENDPOINT = process.env.DATA_CONNECT_ENDPOINT || 'http://localhost:5001/v1/projects/sppsmkcengkareng2/locations/us-central1/connectors/demo';

app.use(cors());
app.use(express.json());

// Inisialisasi Firebase Admin untuk fallback realtime sync
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
    console.warn("⚠ FIREBASE_SERVICE_ACCOUNT tidak ditemukan di env. Berjalan tanpa Firestore fallback.");
  }
  return null;
}

const db = initFirebaseAdmin();

// Helper untuk eksekusi query/mutation ke Firebase Data Connect (Cloud SQL PostgreSQL)
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

// Inisialisasi Midtrans Snap Client
const snap = new midtransClient.Snap({
  isProduction: false, // Ubah ke true jika sudah production
  serverKey: process.env.MIDTRANS_SERVER_KEY || 'SB-Mid-server-xX2v9W0y_V8R3RjGqH_Vv7s-',
  clientKey: process.env.MIDTRANS_CLIENT_KEY || 'Mid-client-U0pExnksmEJZEOTR'
});

// Endpoint dasar untuk cek konektivitas backend
app.get('/', (req, res) => {
  res.status(200).json({ status: 'running', message: 'Backend MySaceng Active & Integrated with Cloud SQL Data Connect' });
});

// 1. ENDPOINT: MEMBUAT TRANSAKSI / TOKEN SNAP MIDTRANS
app.post('/api/payment/token', async (req, res) => {
  try {
    const { nisn, nama, email, listTagihan, totalBayar } = req.body;

    if (!nisn || !listTagihan || listTagihan.length === 0 || !totalBayar) {
      return res.status(400).json({ error: 'Data pembayaran tidak lengkap!' });
    }

    const orderId = `INV-SPP-${Date.now()}-${nisn}`;
    const cleanEmail = email || `${nisn}@student.smkcengkareng2.sch.id`;

    // Gabungkan list idTagihan menjadi string yang dipisahkan koma untuk ditaruh di custom_field1
    const tagihanIdsString = listTagihan.map(t => t.idTagihan).join(',');

    // Gabungkan nama-nama item pembayaran sebagai deskripsi item Midtrans
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
      custom_field1: tagihanIdsString, // Mengirimkan ID Tagihan ke Midtrans agar dikembalikan saat webhook
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

// 2. ENDPOINT: WEBHOOK NOTIFIKASI MIDTRANS (SINKRONISASI PEMBAYARAN KAS MASUK)
app.post('/api/payment/notification', async (req, res) => {
  try {
    const statusResponse = req.body;
    const orderId = statusResponse.order_id;
    const transactionStatus = statusResponse.transaction_status;
    const fraudStatus = statusResponse.fraud_status;
    const paymentType = statusResponse.payment_type;
    const grossAmount = statusResponse.gross_amount;
    const customField1 = statusResponse.custom_field1; // Berisi daftar idTagihan (koma terpisah)

    console.log(`⚡ Menerima Webhook Midtrans: OrderID ${orderId} | Status: ${transactionStatus}`);

    // Ekstrak NISN dari Order ID (Format: INV-SPP-TIMESTAMP-NISN)
    const orderParts = orderId.split('-');
    const nisn = orderParts[orderParts.length - 1];

    if (transactionStatus === 'settlement' || transactionStatus === 'capture') {
      if (fraudStatus === 'accept' || transactionStatus === 'settlement') {
        
        const dateStr = getFormattedCurrentDateTime();
        const cleanMethod = paymentType ? paymentType.toUpperCase().replace('_', ' ') : 'MIDTRANS';
        const itemTitle = "Pelunasan Pembayaran Online via Portal";

        // A. INTEGRASI KE CLOUD SQL VIA FIREBASE DATA CONNECT
        // 1. Catat Transaksi Log Baru di PostgreSQL
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

        await executeDataConnect('CatatTransaksiLog', sqlCatatTransaksi, {
          idTransaksi: orderId,
          siswaNisn: nisn,
          staffUsername: null, // NULL karena transaksi online otomatis tanpa staff TU
          namaItemPembayaran: itemTitle,
          jumlahDiterima: parseInt(grossAmount),
          tanggalWaktuBayar: dateStr,
          metodePembayaran: cleanMethod,
          waktuSistemUnix: Date.now()
        });
        console.log(`✓ [PostgreSQL Cloud SQL] Log transaksi ${orderId} sukses dicatat.`);

        // 2. Lunasi seluruh tagihan terkait di PostgreSQL yang disimpan di customField1
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
              await executeDataConnect('LunasiTagihanSiswa', sqlLunasiTagihan, {
                idTagihan: idTagihan.trim(),
                statusPembayaran: "Lunas",
                tanggalPelunasan: dateStr,
                nomorReferensiTransaksi: orderId
              });
              console.log(`✓ [PostgreSQL Cloud SQL] Tagihan ${idTagihan} berhasil dilunasi.`);
            }
          }
        } else {
          console.warn("⚠ Notifikasi sukses diterima tanpa adanya data custom_field1 (ID Tagihan).");
        }

        // B. FALLBACK REALTIME SINKRONISASI FIRESTORE (Dibungkus try-catch agar error Firestore tidak membatalkan transaksi PostgreSQL utama)
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

            // Tandai status pembayaran tagihan menjadi 'Lunas' di Firestore juga agar realtime
            if (customField1) {
              const listIdTagihan = customField1.split(',');
              for (const idTagihan of listIdTagihan) {
                const tagihanRef = db.collection('artifacts').doc(appId).collection('public').doc('data').collection('students').doc(nisn).collection('tagihan').doc(idTagihan.trim());
                // Perbarui status tagihan di Firestore jika ada subcollection
                await tagihanRef.set({
                  statusPembayaran: "Lunas",
                  tanggalPelunasan: dateStr,
                  nomorReferensiTransaksi: orderId
                }, { merge: true });
              }
            }
            console.log(`✓ [Firestore Fallback] Realtime synchronization sukses.`);
          } catch (fsError) {
            console.error("⚠ [Firestore Fallback] Gagal melakukan sinkronisasi realtime, namun data utama di PostgreSQL tetap aman:", fsError.message);
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