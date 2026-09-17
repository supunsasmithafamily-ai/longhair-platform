/**
 * Backend for the Long Hair Earn platform.
 *
 * Design principle: the browser is never trusted to say "I paid" or
 * "I earned this" by itself. Every place real money moves (a private
 * content sale, a creator-upgrade fee, an ad-revenue payout, a
 * referral bonus, a withdrawal being marked paid) goes through a
 * function here, which either (a) independently re-checks the claim
 * with PayPal's API, or (b) requires the caller to hold the `admin`
 * custom claim, set once via scripts/set-admin.js (see README).
 */

const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { setGlobalOptions } = require("firebase-functions/v2");
const { defineSecret } = require("firebase-functions/params");
const admin = require("firebase-admin");
const fetch = require("node-fetch");

admin.initializeApp();
const db = admin.firestore();
setGlobalOptions({ maxInstances: 10 });

const PAYPAL_CLIENT_ID = defineSecret("PAYPAL_CLIENT_ID");
const PAYPAL_CLIENT_SECRET = defineSecret("PAYPAL_CLIENT_SECRET");
const PAYPAL_MODE = process.env.PAYPAL_MODE || "sandbox"; // "sandbox" | "live"

function paypalBase() {
  return PAYPAL_MODE === "live"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

async function paypalAccessToken(clientId, clientSecret) {
  const res = await fetch(`${paypalBase()}/v1/oauth2/token`, {
    method: "POST",
    headers: {
      Authorization: "Basic " + Buffer.from(`${clientId}:${clientSecret}`).toString("base64"),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: "grant_type=client_credentials",
  });
  if (!res.ok) throw new HttpsError("internal", "Could not authenticate with PayPal.");
  const data = await res.json();
  return data.access_token;
}

function requireLogin(request) {
  if (!request.auth) throw new HttpsError("unauthenticated", "Login required.");
  return request.auth.uid;
}

function requireAdmin(request) {
  if (!request.auth || request.auth.token.admin !== true) {
    throw new HttpsError("permission-denied", "Admin only.");
  }
}

/**
 * Called after the PayPal Buttons flow approves an order in the browser.
 * We re-fetch the order from PayPal ourselves (never trust the amount the
 * client sends), capture it, confirm it was actually paid, and only then
 * write the purchase/earnings/upgrade records.
 */
exports.capturePayPalOrder = onCall(
  { secrets: [PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET] },
  async (request) => {
    const uid = requireLogin(request);
    const { orderID, kind, uploadId } = request.data || {};
    if (!orderID || !kind) throw new HttpsError("invalid-argument", "orderID and kind are required.");

    const token = await paypalAccessToken(PAYPAL_CLIENT_ID.value(), PAYPAL_CLIENT_SECRET.value());

    // What SHOULD this order be worth? Decided server-side, not by the client.
    let expectedUSD, uploadRef, uploadData;
    if (kind === "private_sale") {
      if (!uploadId) throw new HttpsError("invalid-argument", "uploadId required for private_sale.");
      uploadRef = db.collection("uploads").doc(uploadId);
      const snap = await uploadRef.get();
      if (!snap.exists) throw new HttpsError("not-found", "Upload not found.");
      uploadData = snap.data();
      if (uploadData.visibility !== "private") throw new HttpsError("failed-precondition", "Not a private item.");
      expectedUSD = Number(uploadData.priceUSD || 0);
    } else if (kind === "creator_upgrade") {
      expectedUSD = 4.99;
    } else {
      throw new HttpsError("invalid-argument", "Unknown kind.");
    }

    const captureRes = await fetch(`${paypalBase()}/v2/checkout/orders/${orderID}/capture`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    });
    const captureData = await captureRes.json();
    if (!captureRes.ok || captureData.status !== "COMPLETED") {
      throw new HttpsError("failed-precondition", "PayPal did not confirm this payment.");
    }
    const paidUnit = captureData.purchase_units?.[0]?.payments?.captures?.[0];
    const paidUSD = Number(paidUnit?.amount?.value || 0);
    if (Math.abs(paidUSD - expectedUSD) > 0.01) {
      throw new HttpsError("failed-precondition", "Paid amount does not match the expected price.");
    }

    // Idempotency: PayPal order IDs are unique, so use one as the doc ID
    // to guard against the client calling this twice for the same order.
    const ledgerRef = db.collection("paypalCaptures").doc(orderID);
    await db.runTransaction(async (tx) => {
      const already = await tx.get(ledgerRef);
      if (already.exists) return; // already processed, no-op
      tx.set(ledgerRef, {
        uid, kind, uploadId: uploadId || null, amountUSD: paidUSD,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      if (kind === "private_sale") {
        const purchaseRef = db.collection("purchases").doc();
        tx.set(purchaseRef, {
          userId: uid, uploadId, priceUSD: paidUSD,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
        const ownerId = uploadData.userId;
        tx.update(db.collection("users").doc(ownerId), {
          totalSalesUSD: admin.firestore.FieldValue.increment(paidUSD),
        });
        tx.set(db.collection("earnings").doc(), {
          userId: ownerId, type: "private_sale", amount: paidUSD, currency: "USD",
          status: "confirmed", sourceUploadId: uploadId,
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      } else if (kind === "creator_upgrade") {
        tx.update(db.collection("users").doc(uid), { creatorVerified: true, role: "creator" });
      }
    });

    return { ok: true };
  }
);

/**
 * Logs that an ad slot was actually displayed to a viewer, attributed to
 * the upload's owner. This is a *fairness signal* for splitting whatever
 * revenue the admin later confirms came in — it is NOT itself money, and
 * writing this never changes anyone's earnings or balance.
 */
exports.logAdView = onCall(async (request) => {
  const uid = requireLogin(request);
  const { uploadId } = request.data || {};
  if (!uploadId) throw new HttpsError("invalid-argument", "uploadId required.");
  const uploadRef = db.collection("uploads").doc(uploadId);
  const snap = await uploadRef.get();
  if (!snap.exists) throw new HttpsError("not-found", "Upload not found.");
  await uploadRef.update({ adViews: admin.firestore.FieldValue.increment(1) });
  await db.collection("adViewLog").add({
    uploadId, viewerId: uid, ownerId: snap.data().userId,
    createdAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/**
 * Admin-only. Admin has looked at the RichAds / HilltopAds / Kadam
 * dashboards and knows the platform actually received `totalRevenueUSD`
 * for this period. This function splits that real money across creators
 * in proportion to their share of adViews recorded since the last
 * distribution, credits `earnings` (type: ad_share, status: confirmed),
 * updates each creator's totalEarnings, and resets adViews to 0 so the
 * next period starts clean. Nothing here is guessed or promised in
 * advance — it only ever divides up revenue the admin says already
 * landed in the platform's account.
 */
exports.distributeAdRevenue = onCall(async (request) => {
  requireAdmin(request);
  const { periodLabel, totalRevenueUSD } = request.data || {};
  const revenue = Number(totalRevenueUSD);
  if (!periodLabel || !(revenue > 0)) {
    throw new HttpsError("invalid-argument", "periodLabel and a positive totalRevenueUSD are required.");
  }

  const uploadsSnap = await db.collection("uploads").where("adViews", ">", 0).get();
  const totalViews = uploadsSnap.docs.reduce((sum, d) => sum + Number(d.data().adViews || 0), 0);
  if (totalViews === 0) throw new HttpsError("failed-precondition", "No recorded ad views to split revenue across.");

  const perOwner = new Map(); // ownerId -> {views, amount}
  for (const d of uploadsSnap.docs) {
    const x = d.data();
    const views = Number(x.adViews || 0);
    const amount = revenue * (views / totalViews);
    const cur = perOwner.get(x.userId) || { views: 0, amount: 0 };
    cur.views += views; cur.amount += amount;
    perOwner.set(x.userId, cur);
  }

  const batch = db.batch();
  for (const [ownerId, { views, amount }] of perOwner.entries()) {
    const rounded = Math.round(amount * 100) / 100;
    if (rounded <= 0) continue;
    batch.set(db.collection("earnings").doc(), {
      userId: ownerId, type: "ad_share", amount: rounded, currency: "USD",
      status: "confirmed", periodLabel, adViewsCounted: views,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    batch.update(db.collection("users").doc(ownerId), {
      totalEarnings: admin.firestore.FieldValue.increment(rounded),
    });
  }
  for (const d of uploadsSnap.docs) {
    batch.update(d.ref, { adViews: 0 });
  }
  batch.set(db.collection("adRevenuePeriods").doc(), {
    periodLabel, totalRevenueUSD: revenue, totalViews,
    distributedBy: request.auth.uid,
    distributedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  await batch.commit();

  return { ok: true, creatorsPaid: perOwner.size, totalViews };
});

/** Admin-only. Confirms a pending referral is real and credits the bonus. */
exports.approveReferral = onCall(async (request) => {
  requireAdmin(request);
  const { referralId } = request.data || {};
  if (!referralId) throw new HttpsError("invalid-argument", "referralId required.");
  const ref = db.collection("referrals").doc(referralId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Referral not found.");
    const x = snap.data();
    if (x.status !== "pending") return; // already handled
    tx.update(ref, { status: "confirmed", approvedBy: request.auth.uid, approvedAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.set(db.collection("earnings").doc(), {
      userId: x.referrerId, type: "referral", amount: x.bonusAmount, currency: "LKR",
      status: "confirmed", referralId,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
    });
    tx.update(db.collection("users").doc(x.referrerId), {
      totalEarnings: admin.firestore.FieldValue.increment(x.bonusAmount),
    });
  });
  return { ok: true };
});

/** Admin-only. Rejects a pending referral (e.g. suspected self-referral/bot). */
exports.rejectReferral = onCall(async (request) => {
  requireAdmin(request);
  const { referralId, reason } = request.data || {};
  if (!referralId) throw new HttpsError("invalid-argument", "referralId required.");
  await db.collection("referrals").doc(referralId).update({
    status: "rejected", rejectedBy: request.auth.uid, reason: reason || null,
    rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});

/**
 * Admin-only. Call this ONLY after the admin has actually sent the money
 * via PayPal / oxapay outside this app. Also debits the user's
 * totalEarnings so their visible balance reflects reality.
 */
exports.markWithdrawalPaid = onCall(async (request) => {
  requireAdmin(request);
  const { withdrawalId } = request.data || {};
  if (!withdrawalId) throw new HttpsError("invalid-argument", "withdrawalId required.");
  const ref = db.collection("withdrawals").doc(withdrawalId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found", "Withdrawal not found.");
    const x = snap.data();
    if (x.status === "paid") return;
    tx.update(ref, { status: "paid", paidBy: request.auth.uid, paidAt: admin.firestore.FieldValue.serverTimestamp() });
    tx.update(db.collection("users").doc(x.userId), {
      totalEarnings: admin.firestore.FieldValue.increment(-Number(x.amountUSD || 0)),
    });
  });
  return { ok: true };
});

/** Admin-only. Rejects a withdrawal request without paying it. */
exports.rejectWithdrawal = onCall(async (request) => {
  requireAdmin(request);
  const { withdrawalId, reason } = request.data || {};
  if (!withdrawalId) throw new HttpsError("invalid-argument", "withdrawalId required.");
  await db.collection("withdrawals").doc(withdrawalId).update({
    status: "rejected", rejectedBy: request.auth.uid, reason: reason || null,
    rejectedAt: admin.firestore.FieldValue.serverTimestamp(),
  });
  return { ok: true };
});
