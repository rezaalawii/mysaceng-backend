const express = require('express');
const cors = require('cors');
const midtransClient = require('midtrans-client');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// 1. Mengaktifkan CORS agar diizinkan diakses oleh domain Firebase Anda
app.use(cors({
  origin: 'https://sppsmkcengkareng2.web.app', // Hanya izinkan domain web Anda
  methods: ['GET', 'POST'],
  credentials: true
}));

app.use(express.json());

// Endpoint Kesehatan Server (Health Check)
app.get('/healthz', (req, res) => {
  res.status(200).send('OK');
});

// 2. Endpoint untuk Membuat Token Transaksi Midtrans
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

    // Inisialisasi Midtrans Snap client secara aman menggunakan Environment Variable
    const snap = new midtransClient.Snap({
      isProduction: false, // Set ke true jika sudah production
      serverKey: serverKey
    });

    const orderId = `INV-${type.toUpperCase()}-${nisn}-${Date.now()}`;

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

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});