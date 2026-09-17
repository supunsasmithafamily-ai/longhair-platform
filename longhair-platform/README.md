# Long Hair Earn — backend

This wires your `index.html` up to a real backend on Firebase (Auth,
Firestore, Storage, Cloud Functions) and adds an admin panel
(`public/admin.html`).

## What changed from your original file, and why

Your original page had the browser itself write things like "give this
user Rs.1000" or "mark this account as a paid creator" straight into the
database. Anyone can open devtools on any website and run that same
JavaScript by hand — so as it was, any visitor could have credited
themselves unlimited earnings or free private content without paying
anything. That's now fixed:

- **Uploading no longer pays an instant bonus.** A creator's real income
  is (a) actual private-content sales, and (b) a share of actual ad
  revenue, both below.
- **Private-content purchases and the $4.99 creator upgrade** are
  captured and verified server-side (`capturePayPalOrder` in
  `functions/index.js`), which re-checks the payment with PayPal's own
  API before writing anything. The client can no longer just claim "I
  paid" and unlock content for free.
- **Ad revenue** is split among creators by `distributeAdRevenue`, which
  only ever divides up a dollar figure *you* (the admin) type into
  `admin.html` after checking your RichAds/HilltopAds/Kadam dashboards.
  It splits that real money in proportion to each creator's logged ad
  views. No money is invented — it only ever redistributes what actually
  came in.
- **Referral bonuses** are created as `pending` and only pay out once you
  approve them in the admin panel (so you can catch self-referrals or
  bots before they cost you money).
- **Withdrawals** are still manual — a user requests one, you send the
  money yourself via PayPal or crypto (oxapay), then mark it paid in
  the admin panel. There's no automatic payout integration here; that's
  a reasonable v1 for a platform your size.

This is a much safer starting point, but you're still running something
that moves real money — please get comfortable with Firebase billing
(Functions require the Blaze pay-as-you-go plan), PayPal's developer
dashboard, and your tax/business registration obligations in Sri Lanka
before taking real payments.

## 1. Create the Firebase project

You already have one (`studio-2796008461-e6419`, visible in the config
in `index.html`). If you want a fresh one instead, create it at
https://console.firebase.google.com, then replace `firebaseConfig` in
both `public/index.html` and `public/admin.html`.

In the console, enable:
- **Authentication** → Email/Password
- **Firestore Database** (production mode)
- **Storage**
- **Functions** → this requires upgrading to the **Blaze** (pay-as-you-go)
  plan. You still get a generous free tier; you're only billed for usage
  beyond it.

## 2. Install the Firebase CLI and log in

```bash
npm install -g firebase-tools
firebase login
cd longhair-platform
firebase use --add     # pick your project, give it an alias like "default"
```

## 3. Install function dependencies

```bash
cd functions
npm install
cd ..
```

## 4. Set your PayPal credentials

Get a **Client ID** and **Secret** from https://developer.paypal.com
(start in Sandbox mode for testing, switch to Live once you're ready to
take real payments).

```bash
firebase functions:secrets:set PAYPAL_CLIENT_ID
firebase functions:secrets:set PAYPAL_CLIENT_SECRET
```

To switch from sandbox to live, set the `PAYPAL_MODE` environment
variable to `live` for the functions deploy (see Firebase's docs on
`functions/.env` files) — default is `sandbox`.

You also need your PayPal **Client ID** in the frontend for the Buttons
SDK. It's already wired up near the top of `index.html`:

```html
<script src="https://www.paypal.com/sdk/js?client-id=PAYPAL_CLIENT_ID_HERE&currency=USD" ...></script>
```

Replace `PAYPAL_CLIENT_ID_HERE` with the same Client ID you used for the
secret above.

## 5. Deploy Firestore/Storage rules and the functions

```bash
firebase deploy --only firestore:rules,firestore:indexes,storage:rules,functions
```

## 6. Bootstrap your admin account

Register a normal account first through the app itself (or Firebase
Console → Authentication → Add user), then grant it admin:

```bash
# Firebase Console → Project Settings → Service Accounts →
# "Generate new private key" → save as scripts/serviceAccountKey.json
node scripts/set-admin.js you@example.com
```

Sign out and back in on `admin.html` for the claim to take effect.

## 7. Fill in your ad network zone IDs

In `public/index.html`, replace:

```js
const KADAM_ZONE_ID = "YOUR_ZONE_ID";
const RICHADS_ZONE_ID = "YOUR_RICHADS_ZONE_ID";
const HILLTOP_ZONE_ID = "YOUR_HILLTOP_ZONE_ID";
```

and the placeholder `src` URLs a few lines below (`https://richads.example/tag.js`,
`https://hilltopads.example/tag.js`) with the exact `<script>` tag each
network gives you when you create a zone in their dashboard — copy the
real src URL from there, since these details vary and change.

## 8. Deploy the frontend

**Option A — Firebase Hosting** (simplest, same project as everything else):
```bash
firebase deploy --only hosting
```

**Option B — Vercel** (since you mentioned it):
```bash
npm install -g vercel
vercel --cwd public
```
Cloud Functions still run on Firebase either way — Vercel would only be
hosting the static `public/` folder.

## 9. Push to GitHub

```bash
git add -A
git commit -m "Long Hair Earn backend"
git remote add origin https://github.com/YOUR_USERNAME/YOUR_REPO.git
git branch -M main
git push -u origin main
```
Then connect that repo in Vercel's dashboard for automatic deploys on
push, if you're using Option B.

## Still to configure yourself

- **oxapay**: the withdrawal form supports it as a payout *method label*
  (an admin manually sends crypto and marks the request paid) — there's
  no live oxapay API integration here. If you want automatic crypto
  payouts, get an API key from https://oxapay.com and I can wire up
  their payout endpoint once you have it.
- **Agora (live video)**: not included — say the word and I'll add a
  live-streaming tab once you've created an Agora project and have an
  App ID.
- **RichAds / HilltopAds real tag snippets** (step 7 above).
- **PayPal Client ID** in the frontend `<script>` tag (step 4).
