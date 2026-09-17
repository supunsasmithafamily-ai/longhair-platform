/**
 * One-off script to grant (or revoke) the `admin` custom claim on a user.
 * This is deliberately NOT a callable Cloud Function — if it were, anyone
 * could try to call it and make themselves admin. Run it locally instead,
 * with a service account key that only you have.
 *
 * Setup:
 *   1. Firebase Console → Project Settings → Service Accounts →
 *      "Generate new private key" → save as scripts/serviceAccountKey.json
 *      (this file is gitignored — never commit it)
 *   2. cd functions && npm install    (installs firebase-admin here too)
 *   3. node scripts/set-admin.js you@example.com
 *      node scripts/set-admin.js you@example.com --revoke
 */
const admin = require("../functions/node_modules/firebase-admin");
const path = require("path");

const email = process.argv[2];
const revoke = process.argv.includes("--revoke");
if (!email) {
  console.error("Usage: node scripts/set-admin.js you@example.com [--revoke]");
  process.exit(1);
}

admin.initializeApp({
  credential: admin.credential.cert(require(path.join(__dirname, "serviceAccountKey.json"))),
});

admin.auth().getUserByEmail(email)
  .then((user) => admin.auth().setCustomUserClaims(user.uid, { admin: !revoke }))
  .then(() => {
    console.log(`${revoke ? "Revoked" : "Granted"} admin claim for ${email}. They must sign out and back in for it to take effect.`);
    process.exit(0);
  })
  .catch((err) => { console.error(err); process.exit(1); });
