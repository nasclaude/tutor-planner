# Tutor Planner

A phone app for private tutoring and everyday planning. Schedule lessons and get reminders on your iPhone
3, 2 and 1 hours before each one, move a lesson with one tap, add your own reminders with notes, and keep
track of students, grades, homework and payments. Available in English and Bulgarian, with a pink
"Flamingo" theme in light and dark mode. You can invite other people: everyone gets their own private account.

## How it works

```
iPhone (app from GitHub Pages)  ⇄  Cloudflare Worker (API + database)  →  🔔 push notification
```

- **`web/`** is the app. It is plain HTML/CSS/JavaScript with no build step, hosted for free on GitHub Pages.
  Add it to the iPhone Home Screen and it behaves like a normal app.
- **`worker/`** is a small Cloudflare Worker (free plan). It stores everyone's students, lessons, notes, grades
  and homework in a D1 database, and only ever hands each person their own. Every minute it checks for
  reminders that are due and sends them as Web Push notifications to that person's phones.
- **`dev/`** runs everything locally without Cloudflare, for trying things out.

The repository is public but holds **no data**: student information only lives in your Cloudflare database.

## Features

- **Today:** the next lesson with a countdown, everything planned for today and the next 7 days, and lessons
  that already ended but were never marked as done or cancelled. Every lesson and reminder has a tick circle:
  one tap marks it completed (with Undo), another tap puts it back.
- **Reminders (planner):** anything that isn't a lesson, like "Call the bank", with a note underneath. Each one can
  notify you at the time and/or 5 min to 1 day before. Tick the circle when it's done, or move it with one tap.
  Reminders have the same states as lessons: completed ones turn green, cancelled ones are struck through
  (and stop notifying), and both can be reopened.
  The **+** button asks whether you're adding a lesson or a reminder.
- **Lesson:** *Completed* (with notes, homework and payment in one step) or *Cancel*; move it with
  −1 h / +1 h / +2 h / Tomorrow / +1 week / pick a time; every change can be undone.
- **Repeating lessons and reminders:** after you add one, the app asks "Repeat this lesson?": just once, or
  every week / every 2 weeks / every month for 3, 6 or 12 months (it shows how many will be created). Each copy
  is a normal entry you can edit, move, complete or cancel on its own. Deleting one asks whether to delete
  just it or it and all later ones in the series.
- **Reminders per lesson and per note:** an on/off switch plus any mix of times (1 day, 4 h, 3 h, 2 h, 1 h,
  30 min, 15 min, 5 min, at the time). Turning reminders off keeps the chosen times for when you turn them
  back on. New lessons start with the default times from Settings; new notes with "at the time".
  In lists, a bell under the time means notifications are on; the dot shows the kind (pink lesson, coral note).
- **Week:** a calendar grid with lessons (pink) and reminders (coral). Each block shows its time, full title
  and, if there's room, the topic or note. On a phone about 3½ days fit and you swipe sideways for the rest;
  it opens at today. Overlapping items are stacked like cards so both stay readable. Tap an empty slot to add
  something there.
- **Students:** subject, grade, school, phone, parent contact, price per lesson and notes; each student has
  tabs for lessons, grades (with an average) and homework. The overview has three money windows:
  - **Total value** is what all their lessons are worth, past and upcoming. Cancelled lessons don't count,
    unless they were paid anyway.
  - **Already paid** is what you have received, with the share of the total.
  - **Owes you** is completed lessons that aren't paid yet.

  The windows update as soon as a lesson is marked paid, not paid or cancelled.
- **Money:** earned, received and unpaid amounts per month, plus who owes you, with *Paid* buttons.
- **Settings:** switch the language between English and Български, turn notifications on for this device,
  choose the default reminder times for new lessons (3 h, 2 h and 1 h before), set the usual lesson length
  and currency, download a backup, change your password and log out. The owner also sees **People**.

The language is saved on the server as well, so notifications arrive in the same language as the app.
Texts live in `web/js/i18n.js` (one dictionary per language).

## Accounts and privacy

- **Invite-only.** On first launch the app asks for the `SETUP_CODE` (a secret you set on Cloudflare) and creates
  the **owner** account, which is you. Anything already in the database becomes yours.
- **Inviting:** *Settings → People → Invite someone* gives a code and a link (`…/#/join/K7QX3MPA`) to send.
  It works once and expires after 14 days. The person picks their own username and password.
- **Private data:** students, lessons, notes, grades, homework, payments, settings and notification devices all
  belong to one account. The server checks this on every request, so even the owner can't see anyone else's data.
- **Forgotten password:** the owner taps the person under *People → Reset password* and passes on the temporary
  password. Their old logins stop working, and after logging in the app asks them to choose a new password.
- **Removing someone** deletes their account and all their data for good.
- **Logging out** deletes the copy of the data kept on that phone and stops notifications to it.
- Passwords are stored salted and hashed (PBKDF2 plus a secret pepper), never as plain text. After 10 wrong
  attempts within 15 minutes on one username, or from one network, logins there are paused for 15 minutes.
- You are hosting other people's data, so tell them what is stored. If someone asks for their data to be
  deleted, *Remove* does exactly that.

## Try it locally

```bash
node dev/server.mjs             # open http://localhost:8080
node dev/server.mjs --seed      # same, with demo data if the database is empty (log in as owner / demo1234)
cd worker && npm test           # server tests
```

With an empty database the app first asks you to set up the owner account. The local setup code is `dev`.
The preview keeps its data in `dev/dev.db` (not uploaded to GitHub), so it survives restarts. Delete that file
to start over. `--port 9080` runs a second copy alongside (its API is always on the page's port + 707), and
`--memory` keeps data in memory only, for automated tests.

## Putting it online (one-time setup)

You need free GitHub and Cloudflare accounts.

1. **Log in to Cloudflare:** `cd worker && npx wrangler login`
2. **Create the database** with `npx wrangler d1 create tutor-planner`, paste the printed `database_id`
   into `worker/wrangler.toml`, then run `npm run migrate`.
3. **Set the secrets.** You type the setup code yourself, so nobody else ever sees it:
   - `npx wrangler secret put SETUP_CODE`: a code you make up; you need it once, to create your owner account
   - `openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET`
   - `openssl rand -base64 32 | npx wrangler secret put PASSWORD_PEPPER`. **Never change this one** once people
     have joined: every password would stop working.
   - `node scripts/generate-vapid.mjs --jwk-only | npx wrangler secret put VAPID_PRIVATE_JWK`
4. **Fill in your GitHub username** in `ALLOWED_ORIGINS` and `VAPID_SUBJECT` (`worker/wrangler.toml`),
   then run `npm run deploy`. Copy the `https://tutor-planner-api.<something>.workers.dev` address it prints into
   `web/config.js`.
5. **Publish the app:** push this repository to GitHub as `tutor-planner`. Then under
   *Settings → Pages → Source*, choose **GitHub Actions**. The app will appear at
   `https://<username>.github.io/tutor-planner/`.
6. **First launch:** open the app, enter your setup code and create your owner account. Then invite people
   from *Settings → People*.

## On the iPhone (iOS 16.4 or newer)

1. Open the app's address in **Safari**, tap **Share** and choose **Add to Home Screen**.
2. Open **Tutor** from the Home Screen and log in. (People you invite open their invite link first, create
   their account, and then add the app to their Home Screen the same way.)
3. Go to **Settings → Turn on reminders**, allow notifications, then tap **Send a test notification**.

Notifications only work from the Home Screen app, not from a normal Safari tab (that's how iOS works).

## Everyday changes

- App changes: edit `web/` and push; GitHub publishes it within about a minute.
- Server changes: edit `worker/` and run `npm test`, then `npm run deploy`.
- Change your password: *Settings → Change password*. Someone forgot theirs: *Settings → People → Reset password*.
- Log everyone out of every device: set a new `SESSION_SECRET`.
- See server logs: `npm run logs`.

## Notes

- `worker/.npmrc` makes npm use `/bin/sh` for install scripts (the system `sh` on this Mac is shadowed by a
  personal shortcut).
- Cloudflare's local runtime needs macOS 13.5+, so `dev/` has its own small stand-in for D1 built on Node's
  SQLite. Deploying works fine on older macOS.
