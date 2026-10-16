const {onCall, onRequest, HttpsError} = require("firebase-functions/https");
const {defineSecret} = require("firebase-functions/params");
const {onDocumentCreated} = require("firebase-functions/v2/firestore");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");
const {getMessaging} = require("firebase-admin/messaging");

initializeApp();

const auth = getAuth();
const db = getFirestore();
const messaging = getMessaging();

exports.createEmployeeAccount = onCall(async (request) => {
  // Hanya Admin/Company yang sudah login yang boleh
  // memanggil function ini.
  if (!request.auth) {
    throw new HttpsError(
        "unauthenticated",
        "User CLIME-X belum login.",
    );
  }

  const adminUid = request.auth.uid;

  const name = String(
      request.data && request.data.name ?
        request.data.name :
        "",
  ).trim();

  const employeeId = String(
      request.data && request.data.employeeId ?
        request.data.employeeId :
        "",
  ).trim().toLowerCase();

  const password = String(
      request.data && request.data.password ?
        request.data.password :
        "",
  );

  // Validasi nama
  if (!name) {
    throw new HttpsError(
        "invalid-argument",
        "Nama Employee wajib diisi.",
    );
  }

  if (/\s/.test(name)) {
    throw new HttpsError(
        "invalid-argument",
        "Nama Employee tidak boleh mengandung spasi.",
    );
  }

  // Validasi Employee ID
  if (!employeeId) {
    throw new HttpsError(
        "invalid-argument",
        "Employee ID wajib diisi.",
    );
  }

  if (!/^[a-z0-9._%+-]+@[a-z0-9.-]+\.com$/.test(employeeId)) {
    throw new HttpsError(
        "invalid-argument",
        "Employee ID tidak valid.",
    );
  }

  // Firebase Authentication membutuhkan password
  // minimal 6 karakter.
  if (password.length < 6) {
    throw new HttpsError(
        "invalid-argument",
        "Password minimal 6 karakter.",
    );
  }

  let userRecord = null;

  try {
    // Buat akun Firebase Authentication.
    userRecord = await auth.createUser({
      email: employeeId,
      password: password,
      displayName: name,
      emailVerified: false,
      disabled: false,
    });

    // Simpan data Employee TANPA password.
    const employeeRef = db
        .collection("users")
        .doc(adminUid)
        .collection("climex")
        .doc("employeeAccounts")
        .collection("items")
        .doc(employeeId);

    await employeeRef.set({
      name: name,
      employeeId: employeeId,
      authUid: userRecord.uid,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    }, {merge: true});

    const employeeProfileRef = db
        .collection("employeeProfiles")
        .doc(userRecord.uid);

    await employeeProfileRef.set({
      adminUid: adminUid,
      name: name,
      employeeId: employeeId,
      authUid: userRecord.uid,
      updatedAt: FieldValue.serverTimestamp(),
      createdAt: FieldValue.serverTimestamp(),
    }, {merge: true});

    return {
      success: true,
      authUid: userRecord.uid,
      employeeId: employeeId,
    };
  } catch (error) {
    console.error(
        "CLIME-X CREATE EMPLOYEE ERROR:",
        error,
    );

    // Kalau Auth berhasil dibuat tetapi Firestore gagal,
    // hapus kembali akun Auth supaya tidak ada akun yatim.
    if (userRecord && userRecord.uid) {
      try {
        await auth.deleteUser(userRecord.uid);
      } catch (cleanupError) {
        console.error(
            "CLIME-X EMPLOYEE CLEANUP ERROR:",
            cleanupError,
        );
      }
    }

    if (error.code === "auth/email-already-exists") {
      throw new HttpsError(
          "already-exists",
          "Employee ID tersebut sudah terdaftar.",
      );
    }

    throw new HttpsError(
        "internal",
        "Akun Employee gagal dibuat.",
    );
  }
});

/**
 * PUSH NOTIFICATION CLIME-X EMPLOYEE
 *
 * Saat notification Employee/DM dibuat oleh index.html:
 *
 * users/{adminUid}/climex/notifications/employees/{recipientUid}/items/{notificationId}
 *
 * Cloud Function ini otomatis mengambil FCM token dari:
 *
 * employeeProfiles/{recipientUid}.fcmToken
 *
 * lalu mengirim DATA-ONLY FCM ke Android.
 *
 * Android kemudian membuat notification native sendiri.
 */
exports.sendEmployeeNotificationPush = onDocumentCreated(
    "users/{adminUid}/climex/notifications/employees/{recipientUid}/items/{notificationId}",
    async (event) => {
      const snapshot = event.data;

      if (!snapshot) {
        return;
      }

      const data = snapshot.data() || {};
      const recipientUid = String(
          event.params.recipientUid || "",
      ).trim();

      if (!recipientUid) {
        return;
      }

      const profileRef = db
          .collection("employeeProfiles")
          .doc(recipientUid);

      const profileSnap = await profileRef.get();

      if (!profileSnap.exists) {
        console.warn(
            "CLIME-X FCM: employee profile tidak ditemukan:",
            recipientUid,
        );
        return;
      }

      const profile = profileSnap.data() || {};
      const token = String(profile.fcmToken || "").trim();

      if (!token) {
        console.warn(
            "CLIME-X FCM: token belum terdaftar untuk:",
            recipientUid,
        );
        return;
      }

      const notificationId = String(
          event.params.notificationId || snapshot.id || "",
      );

      const type = String(data.type || "").trim();

      const payload = {
        source: "climex_employee",
        notificationId: notificationId,
        type: type,
        announcementId: String(data.announcementId || ""),
        commentId: String(data.commentId || ""),
        claimId: String(data.claimId || ""),
        leaveId: String(data.leaveId || ""),
        eventId: String(data.eventId || ""),
        settingsId: String(data.settingsId || ""),
        photoIndex: data.photoIndex == null ?
          "" :
          String(data.photoIndex),
        announcementTitle: String(
            data.announcementTitle ||
            data.contextText ||
            data.title ||
            data.senderName ||
            "Clime-X",
        ).slice(0, 180),
        body: String(
            data.androidBody ||
            data.contextText ||
            "Notifikasi baru",
        ).replace(/<[^>]*>/g, "").slice(0, 240),
      };

      // Data DM
      if (type === "direct_message") {
        payload.messageId = String(data.messageId || "");
        payload.threadId = String(data.threadId || "");
        payload.senderUid = String(
            data.senderUid || data.actorUid || "",
        );
        payload.senderName = String(
            data.senderName || data.actorName || "Pesan masuk",
        );
        payload.fileName = String(data.fileName || "");
        payload.attachmentType = String(
            data.attachmentType || "",
        );
      }

      // Jangan memasukkan base64 foto ke FCM.
      // Payload FCM dibatasi ukurannya dan Android akan
      // menangani thumbnail pada tahap berikutnya.
      try {
        const result = await messaging.send({
          token: token,
          data: payload,
          android: {
            priority: "high",
          },
        });

        console.log(
            "CLIME-X FCM PUSH SENT:",
            recipientUid,
            notificationId,
            result,
        );
      } catch (error) {
        console.error(
            "CLIME-X FCM SEND ERROR:",
            recipientUid,
            notificationId,
            error,
        );

        // Token sudah tidak valid -> hapus supaya tidak
        // terus dipakai pada pengiriman berikutnya.
        const code = String(error.code || "");

        if (
          code.includes("registration-token-not-registered") ||
          code.includes("invalid-registration-token")
        ) {
          try {
            await profileRef.set({
              fcmToken: FieldValue.delete(),
              fcmTokenUpdatedAt: FieldValue.delete(),
            }, {merge: true});
          } catch (cleanupError) {
            console.error(
                "CLIME-X FCM TOKEN CLEANUP ERROR:",
                cleanupError,
            );
          }
        }
      }
    },
);

const MIDTRANS_SERVER_KEY = defineSecret("MIDTRANS_SERVER_KEY");

// Membuat transaksi Snap. Harga ditentukan backend,
// bukan dipercaya dari browser.
exports.createSnapTransaction = onCall(
  {secrets: [MIDTRANS_SERVER_KEY]},
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Silakan login.");
    }

    const packages = {
      go30: {name: "CLIME-X PRO 30 Hari", amount: 110000},
      go365: {name: "CLIME-X PRO 365 Hari", amount: 1250000},
    };

    const packageId = String(request.data?.packageId || "");
    const selected = packages[packageId];

    if (!selected) {
      throw new HttpsError("invalid-argument", "Paket tidak valid.");
    }

    const uid = request.auth.uid;
    const orderId = `CLX-${uid.slice(0, 12)}-${Date.now()}`;
    const serverKey = MIDTRANS_SERVER_KEY.value();
    const auth = Buffer.from(`${serverKey}:`).toString("base64");

    const payload = {
      transaction_details: {
        order_id: orderId,
        gross_amount: selected.amount,
      },
      item_details: [{
        id: packageId,
        price: selected.amount,
        quantity: 1,
        name: selected.name,
      }],
      customer_details: {
        first_name: String(request.auth.token.name || "CLIME-X User")
          .slice(0, 50),
        email: request.auth.token.email || undefined,
      },
    };

    try {
      const response = await fetch(
        "https://app.sandbox.midtrans.com/snap/v1/transactions",
        {
          method: "POST",
          headers: {
            "Authorization": `Basic ${auth}`,
            "Content-Type": "application/json",
            "Accept": "application/json",
          },
          body: JSON.stringify(payload),
        },
      );

      const result = await response.json();

      if (!response.ok || !result.token || !result.redirect_url) {
        console.error("MIDTRANS SNAP ERROR", response.status, result);
        throw new HttpsError(
          "internal",
          "Transaksi belum dapat dibuat. Silakan coba lagi.",
        );
      }

      await db.collection("paymentOrders").doc(orderId).set({
        uid,
        packageId,
        amount: selected.amount,
        currency: "IDR",
        status: "pending",
        snapToken: result.token,
        createdAt: FieldValue.serverTimestamp(),
      });

      return {
        orderId,
        token: result.token,
        redirectUrl: result.redirect_url,
      };
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      console.error("MIDTRANS REQUEST ERROR", error);
      throw new HttpsError("internal", "Gagal menghubungi Midtrans.");
    }
  },
);

// Webhook: status transaksi diverifikasi kembali ke API Midtrans.
exports.midtransWebhook = onRequest(
  {secrets: [MIDTRANS_SERVER_KEY]},
  async (req, res) => {
    if (req.method !== "POST") {
      return res.status(405).send("Method not allowed");
    }

    const orderId = String(req.body?.order_id || "");
    if (!orderId || !/^[A-Za-z0-9_-]+$/.test(orderId)) {
      return res.status(400).send("Invalid order ID");
    }

    try {
      const auth = Buffer.from(
        `${MIDTRANS_SERVER_KEY.value()}:`,
      ).toString("base64");

      const response = await fetch(
        `https://api.sandbox.midtrans.com/v2/${encodeURIComponent(orderId)}/status`,
        {
          headers: {
            "Authorization": `Basic ${auth}`,
            "Accept": "application/json",
          },
        },
      );

      const result = await response.json();

      if (!response.ok || result.order_id !== orderId) {
        return res.status(400).send("Status verification failed");
      }

      const orderRef = db.collection("paymentOrders").doc(orderId);
      const orderSnap = await orderRef.get();

      if (!orderSnap.exists) {
        return res.status(404).send("Order not found");
      }

      const order = orderSnap.data();

      if (Number(result.gross_amount) !== order.amount) {
        return res.status(400).send("Amount mismatch");
      }

      const paid =
        result.transaction_status === "settlement" ||
        (result.transaction_status === "capture" &&
          result.fraud_status === "accept");

      await orderRef.set({
        status: paid ? "paid" : String(result.transaction_status || "pending"),
        paymentType: String(result.payment_type || ""),
        midtransTransactionId: String(result.transaction_id || ""),
        verifiedAt: FieldValue.serverTimestamp(),
      }, {merge: true});

      // Aktivasi paket PRO sengaja belum dilakukan di sini:
      // skema langganan CLIME-X perlu dipastikan terlebih dahulu.
      return res.status(200).send("OK");
    } catch (error) {
      console.error("MIDTRANS WEBHOOK ERROR", error);
      return res.status(500).send("Internal error");
    }
  },
);
Object.assign(exports, require("./kasircuanMidtrans"));