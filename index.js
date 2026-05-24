const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
const admin = require('firebase-admin');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

const appId = process.env.APP_ID || 'mysaceng';

// 1. Menginisialisasi Firebase Admin SDK secara aman untuk mengupdate Firestore langsung dari backend
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    admin.initializeApp({
      credential: admin.credential.cert(serviceAccount)
    });
    console.log("✓ Firebase Admin SDK berhasil diinisialisasi.");
  } catch (err) {
    console.error("✗ Gagal menginisialisasi Firebase Admin SDK:", err);
  }
} else {
  console.warn("⚠ FIREBASE_SERVICE_ACCOUNT tidak ditemukan di Environment Variables. Sistem berjalan tanpa auto-update Firestore.");
}

// 2. Mengaktifkan CORS agar diizinkan diakses oleh domain Firebase / Production Frontend Anda
app.use(cors({
  origin: ['https://sppsmkcengkareng2.web.app', 'http://localhost:5000', 'http://127.0.0.1:5000'],
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Endpoint Kesehatan Server (Health Check)
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// 3. Endpoint untuk Membuat Token Transaksi Midtrans
app.post('/api/payment/token', async (req, res) => {
  try {
    const { nisn, nama, item, amount, index, type } = req.body;

    if (!nisn || !amount) {
      return res.status(400).json({ error: "Parameter nisn dan amount wajib diisi." });
    }

    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    if (!serverKey) {
      console.error("Missing MIDTRANS_SERVER_KEY environment variable");
      return res.status(500).json({ error: "Server configuration error: Missing API Key." });
    }

    // Inisialisasi Midtrans Snap client
    const snap = new midtransClient.Snap({
      isProduction: false, // Set ke true jika sudah production
      serverKey: serverKey
    });

    // Generate Order ID yang unik namun informatif
    // Format: INV-SPP-NISN-INDEX-TIMESTAMP (misal: INV-SPP-0045928120-0-1716550200)
    const orderId = `INV-${type.toUpperCase()}-${nisn}-${index}-${Date.now()}`;

    const parameter = {
      transaction_details: {
        order_id: orderId,
        gross_amount: parseInt(amount)
      },
      customer_details: {
        first_name: nama,
        email: `${nisn}@student.smkcengkareng2.sch.id`
      },
      item_details: [{
        id: `ITEM-${index}`,
        price: parseInt(amount),
        quantity: 1,
        name: item
      }]
    };

    const transaction = await snap.createTransaction(parameter);
    res.status(200).json({ token: transaction.token, redirect_url: transaction.redirect_url });

  } catch (error) {
    console.error("Gagal membuat token Midtrans:", error);
    res.status(500).json({ error: error.message });
  }
});

// 4. Endpoint Webhook Baru untuk Menangkap Notifikasi HTTP Otomatis dari Midtrans
app.post('/api/payment/notification', async (req, res) => {
  try {
    const serverKey = process.env.MIDTRANS_SERVER_KEY;
    if (!serverKey) {
      return res.status(500).json({ error: "Server configuration error: Missing API Key." });
    }

    const snap = new midtransClient.Snap({
      isProduction: false,
      serverKey: serverKey
    });

    // Validasi notifikasi resmi dari Midtrans
    const statusResponse = await snap.transaction.notification(req.body);
    
    const {
      order_id: orderId,
      transaction_status: transactionStatus,
      payment_type: paymentType,
      fraud_status: fraudStatus,
      gross_amount: grossAmount
    } = statusResponse;

    console.log(`[Midtrans Webhook] Menerima status order: ${orderId}. Status: ${transactionStatus}`);

    // Cek apakah status pembayaran sukses
    const isPaymentSuccess = 
      transactionStatus === 'capture' && fraudStatus === 'accept' ||
      transactionStatus === 'settlement';

    if (isPaymentSuccess) {
      // Parsing data dari Order ID (INV-TYPE-NISN-INDEX-TIMESTAMP)
      // Contoh: ["INV", "SPP", "0045928120", "0", "1716550200"]
      const parts = orderId.split('-');
      if (parts.length >= 4 && admin.apps.length > 0) {
        const type = parts[1].toLowerCase(); // "spp" atau "non" / "other"
        const nisn = parts[2];
        const itemIndex = parseInt(parts[3]);

        const db = admin.firestore();
        // Path Strict: /artifacts/{appId}/public/data/students/{nisn}
        const studentRef = db.doc(`artifacts/${appId}/public/data/students/${nisn}`);
        const docSnap = await studentRef.get();

        if (docSnap.exists) {
          const studentData = docSnap.data();
          const dateStr = getFormattedCurrentDateTime();
          const cleanMethod = (paymentType || 'MIDTRANS').toUpperCase();

          let updatedSpp = [...studentData.sppMonths];
          let updatedNonSpp = [...studentData.nonSppTagihan];
          let updatedHistory = studentData.history ? [...studentData.history] : [];
          let itemTitle = "";

          if (type === 'spp') {
            if (updatedSpp[itemIndex]) {
              updatedSpp[itemIndex].s = "Lunas";
              updatedSpp[itemIndex].date = dateStr;
              updatedSpp[itemIndex].ref = `${orderId} - ${cleanMethod}`;
              itemTitle = `SPP ${updatedSpp[itemIndex].m}`;
            }
          } else {
            if (updatedNonSpp[itemIndex]) {
              updatedNonSpp[itemIndex].status = "Lunas";
              itemTitle = updatedNonSpp[itemIndex].name;
            }
          }

          // Tambah ke riwayat transaksi siswa jika belum terdaftar
          const isHistoryExist = updatedHistory.some(h => h.id === orderId);
          if (!isHistoryExist && itemTitle !== "") {
            updatedHistory.unshift({
              id: orderId,
              title: itemTitle,
              amount: parseInt(grossAmount).toLocaleString('id-ID'),
              date: dateStr,
              status: `LUNAS - ${cleanMethod}`
            });
          }

          // Simpan perubahan ke Firestore
          await studentRef.update({
            sppMonths: updatedSpp,
            nonSppTagihan: updatedNonSpp,
            history: updatedHistory
          });

          // Daftarkan ke log transaksi global di Firestore agar Panel Admin TU terupdate instan
          const logRef = db.doc(`artifacts/${appId}/public/data/transaction_logs/${orderId}`);
          await logRef.set({
            id: orderId,
            nama: studentData.nama,
            title: itemTitle,
            amount: parseInt(grossAmount),
            date: dateStr,
            method: cleanMethod,
            timestamp: Date.now()
          });

          console.log(`✓ Database Firestore berhasil terupdate untuk NISN: ${nisn} (${itemTitle})`);
        } else {
          console.warn(`⚠ Siswa dengan NISN ${nisn} tidak ditemukan di database.`);
        }
      }
    }

    res.status(200).send('Notification processed successfully');
  } catch (error) {
    console.error("✗ Gagal memproses Webhook Midtrans:", error);
    res.status(500).json({ error: error.message });
  }
});

// Fungsi pembantu pembacaan waktu lokal server
function getFormattedCurrentDateTime() {
  const now = new Date();
  const date = String(now.getDate()).padStart(2, '0');
  const months = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  const hrs = String(now.getHours()).padStart(2, '0');
  const mins = String(now.getMinutes()).padStart(2, '0');
  return `${date} ${month} ${year}, ${hrs}:${mins}`;
}

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});