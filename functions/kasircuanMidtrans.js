/**
 * KASIR CUAN — Midtrans per-store connection add-on.
 *
 * Add this module alongside the EXISTING Firebase Functions index.js.
 * Do not replace the existing index.js: it contains CLIME-X functions.
 *
 * This module intentionally implements only secure per-store connection
 * validation/storage. Payment creation/webhook settlement are NOT included
 * until the canonical KASIR CUAN sale transaction schema is confirmed.
 */
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp, getApps } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");
const crypto = require("crypto");

if (!getApps().length) initializeApp();
const db = getFirestore();

exports.connectMidtrans = onCall(
  { region: "asia-southeast1", timeoutSeconds: 30 },
  async (request) => {
    if (!request.auth) {
      throw new HttpsError("unauthenticated", "Silakan login kembali.");
    }

    const uid = request.auth.uid;
    const serverKey = String(request.data?.serverKey || "").trim();

    if (!serverKey || serverKey.length < 20 || /\s/.test(serverKey)) {
      throw new HttpsError("invalid-argument", "Server Key tidak valid.");
    }

    // Validate against Midtrans Production without exposing/logging the key.
    const orderId = `KC-CONNECT-${crypto.randomUUID()}`;
    const auth = Buffer.from(`${serverKey}:`).toString("base64");
    let response;

    try {
      response = await fetch(
        `https://api.midtrans.com/v2/${encodeURIComponent(orderId)}/status`,
        {
          method: "GET",
          headers: {
            Authorization: `Basic ${auth}`,
            Accept: "application/json",
          },
          signal: AbortSignal.timeout(15000),
        },
      );
    } catch (_) {
      throw new HttpsError(
        "unavailable",
        "Tidak dapat menghubungi Midtrans. Periksa koneksi lalu coba lagi.",
      );
    }

    if (response.status === 401 || response.status === 403) {
      throw new HttpsError(
        "invalid-argument",
        "Server Key ditolak. Pastikan Server Key Production benar.",
      );
    }

    // A random, nonexistent order normally returns 404; this can validate the key.
    if (response.status !== 404 && !response.ok) {
      throw new HttpsError(
        "unavailable",
        `Midtrans belum dapat memvalidasi koneksi (HTTP ${response.status}). Coba lagi nanti.`,
      );
    }

    // Private server-only secret. Firestore rules must deny client access.
    await db.doc(`midtransGatewaySecrets/${uid}`).set({
      uid,
      serverKey,
      environment: "production",
      connected: true,
      connectedAt: FieldValue.serverTimestamp(),
      validationMethod: "midtrans-status-api",
    }, { merge: true });

    // Public, non-secret connection status for this signed-in store account.
    await db.doc(`users/${uid}/setting/gatewayMidtrans`).set({
      connected: true,
      environment: "production",
      connectedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    }, { merge: true });

    return {
      connected: true,
      message: "Midtrans berhasil terhubung.",
    };
  },
);
