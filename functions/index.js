const {onCall, HttpsError} = require("firebase-functions/https");
const {initializeApp} = require("firebase-admin/app");
const {getAuth} = require("firebase-admin/auth");
const {getFirestore, FieldValue} = require("firebase-admin/firestore");

initializeApp();

const auth = getAuth();
const db = getFirestore();

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
