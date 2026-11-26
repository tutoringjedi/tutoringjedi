# Student Portal: setup guide

The Student Portal lives at **https://tutoringjedi.ca/homework/**. The pages are part of this website, and the data (students, assignments, answers, PDFs, photos) is stored in a free **Supabase** project that you own.

Setup takes about 20 minutes and is done once.

---

## 1. Create the Supabase project

1. Go to https://supabase.com and sign up (the free plan is enough).
2. Click **New project**.
   - **Name:** `tutoringjedi-portal`
   - **Database password:** generate one and keep it in your password manager. The portal doesn't need it.
   - **Region:** **Canada (Central)**, so student data stays in Canada.
3. Wait a minute or two for the project to finish setting up.

## 2. Create the database

1. In the project, open **SQL Editor** → **New query**.
2. Open `homework/supabase/schema.sql` from this repository, copy the whole file, paste it in and click **Run**. You should see "Success".
3. Make yourself the tutor. In a new query, run this, using the email you will sign in with:

   ```sql
   insert into public.tutors (email) values ('tutoringjedi@gmail.com') on conflict do nothing;
   ```

   The email must be lowercase. Only emails in this table can see the tutor dashboard.

## 3. Sign-in settings

1. **Authentication → URL Configuration**
   - **Site URL:** `https://tutoringjedi.ca/homework/`
   - **Redirect URLs:** add `https://tutoringjedi.ca/homework/`
2. **Authentication → Sign In / Providers → Email:** leave **Email** turned on. Students sign in with a link or code, never a password.
3. **Authentication → Email Templates → Magic Link:** replace the message body with the text below. It adds a 6-digit code, so a student can open the email on their phone and type the code on their laptop.

   ```html
   <h2>Sign in to the Tutoring Jedi Student Portal</h2>
   <p><a href="{{ .ConfirmationURL }}">Click here to sign in</a></p>
   <p>Or enter this code on the sign-in page: <strong>{{ .Token }}</strong></p>
   <p>If you didn't ask to sign in, you can ignore this email.</p>
   ```

   Use the same text for the **Confirm signup** template, because a student's first sign-in uses that one.

## 4. Email sending (required for students)

Supabase's built-in email only delivers to members of your Supabase team, and only a few messages an hour. To email students, connect an email provider:

1. Create a free account with an email-sending service, for example Resend, Brevo or Mailgun. They all give you SMTP settings.
2. In Supabase, go to **Authentication → Emails → SMTP Settings**, turn on **custom SMTP** and enter the provider's host, port, username and password.
   - **Sender email:** an address on your domain, e.g. `portal@tutoringjedi.ca`. The provider shows you DNS records to add for `tutoringjedi.ca` so emails don't land in spam.
   - **Sender name:** `Tutoring Jedi`
3. The SMTP password stays in Supabase. Never put it in this repository.

## 5. Connect the website to Supabase

1. In Supabase, open **Project Settings → API Keys** (or **API**). Copy:
   - the **Project URL** (e.g. `https://abcdefgh.supabase.co`)
   - the **anon** / **publishable** key
2. Put them in `homework/config.js`:

   ```js
   window.HW_CONFIG = {
     SUPABASE_URL: "https://abcdefgh.supabase.co",
     SUPABASE_ANON_KEY: "eyJ...",
   };
   ```

   The anon/publishable key is meant to be public: the database rules decide what each person can see. **Never** put the `service_role` / secret key in this file or anywhere in the website.
3. Commit and push. GitHub Pages republishes the site in about a minute.

## 6. First sign-in

1. Go to https://tutoringjedi.ca/homework/, enter your tutor email and click the link or type the code from the email.
2. You'll land on the **Progress** page.

---

## Using the portal

**Add students** (*Students* tab): enter each student's name and the email they'll sign in with. Then click **Email sign-in link**, or **Copy invite** to paste a message into a text or WhatsApp.

**Upload PDFs** (*Library* tab):
- Select one or many PDFs at once and pick a format:
  - *Homework / practice set:* one untimed section; enter the number of questions.
  - *Full digital SAT practice test:* four timed modules: Reading & Writing 27 questions / 32 min ×2, Math 22 questions / 35 min ×2.
  - *SAT Reading & Writing* or *SAT Math* section only.
- Each PDF becomes a reusable item. Files are private: only students you assign them to can open them.

**Answer keys** (click an item in the Library):
- Type answers in the grid, or open **Paste an answer key** and paste, for example:
  ```
  1. B
  2. D
  3. 3/4|.75
  ```
  You can also paste a plain sequence like `B D A C …`.
- Use A–D for multiple choice. Use a number for grid-in (student-produced) questions: `12`, `-3`, `.75` or `3/4`. Equivalent values like 3/4 and 0.75 are accepted automatically. List rounded forms with `|` (e.g. `2/3|.6666|.6667`).
- Leave a question blank to leave it ungraded.
- Questions with a number answer get a type-in box on the student's answer sheet; the rest get A–D bubbles.

**Assign** (*Assign* tab): tick one or more items and one or more students, set a due date and, for tests, tick **Timed**. Students see the work the next time they sign in.

**Track** (*Progress* tab): see every assignment's status (not started, in progress, overdue, submitted), score and time spent. Click a row to see each answer, the correct answer, time per module and any photos the student uploaded. From there you can leave feedback, re-grade after fixing a key, reopen it, or clear answers for a retake.

**What students see:**
- The PDF and an answer sheet side by side (on phones, two tabs).
- Answers save as they go.
- Timed modules count down on the server, so refreshing doesn't reset the clock, and lock when time runs out.
- They can upload photos of their written work.
- After submitting they see their score, which questions to review and your feedback.
- They see correct answers only if you leave **Show correct answers** ticked for that item.

---

## Good to know

- **Free-plan pause:** Supabase pauses free projects after about a week with no activity. If the portal says it can't load, open the Supabase dashboard and click **Restore**. Regular use keeps it awake, and the Pro plan never pauses.
- **Backups:** to keep your own copy, use **Database → Backups** (paid plans) or export tables from the Table Editor as CSV now and then.
- **Removing a student:** *Students* → click the name → **Deactivate** (keeps their history) or **Delete student** (removes their answers and photos too).
- **Privacy:** student names, emails and scores are personal information. Keep the Supabase account protected with a strong password and two-factor authentication. Delete students' data when you stop working with them.
- **Official SAT PDFs:** College Board practice tests are copyrighted. They're kept private here and shown only to students you assign them to. Don't make the storage buckets public.
