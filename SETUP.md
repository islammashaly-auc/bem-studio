# BEM Studio — Setup Guide

## Files in this package

| File | Purpose |
|------|---------|
| `index.html` | Public landing / home page |
| `signup.html` | User registration (username + email + password) |
| `login.html` | Sign-in page |
| `simulator.html` | Auth-gated wrapper — loads the tool ONLY after login |
| `wind_simulator_v9_6.html` | The CFD simulator tool itself |

---

## How the security works

The simulator HTML file is **never delivered to the browser** unless the user has an active, verified Supabase session.

1. When someone visits `simulator.html`, JavaScript immediately calls `sb.auth.getSession()`.
2. If there is no valid session → the user is redirected to `login.html` **before** the iframe src is ever set.
3. Only after a confirmed session does the code set `frame.src = 'wind_simulator_v9_6.html'`.
4. Supabase also listens for `SIGNED_OUT` events in real time — if a session expires mid-use, the user is kicked back to login.

> **Note on "view source" protection:** It is architecturally impossible to fully hide HTML/JS from a browser's DevTools once it has loaded. The correct protection is the above: **never send the file at all without a valid session**. For a higher-security setup, host the tool on a server with a session-cookie check (Node/Python/PHP middleware), so the server refuses the HTTP request itself. This file-based approach handles 99% of casual circumvention.

---

## Supabase setup (takes ~10 minutes, free)

### 1 — Create a free project
1. Go to [https://supabase.com](https://supabase.com) and sign up.
2. Click **New project**, give it a name (e.g. `bem-studio`), choose a region, set a database password.
3. Wait ~1 minute for it to spin up.

### 2 — Enable email auth
1. In your project dashboard, go to **Authentication → Providers**.
2. Make sure **Email** is enabled (it is by default).
3. Under **Authentication → Email Templates**, customise the confirmation email to say "BEM Studio" if you like.

### 3 — Get your API keys
1. Go to **Project Settings → API**.
2. Copy:
   - **Project URL** → paste as `SUPABASE_URL` in all three HTML files
   - **anon / public key** → paste as `SUPABASE_ANON` in all three HTML files

The three places to paste:
- `signup.html` — lines near `const SUPABASE_URL`
- `login.html` — same
- `simulator.html` — same

### 4 — Set the redirect URL
1. In Supabase → **Authentication → URL Configuration**.
2. Add your site URL to **Site URL**, e.g. `https://yourdomain.com`
3. Add `https://yourdomain.com/login.html` to **Redirect URLs**.

### 5 — Deploy
Upload all files to any static host:
- **Netlify** (drag-and-drop deploy) — free
- **Vercel** — free
- **GitHub Pages** — free
- **Your own server** — just serve the folder

---

## User flow

```
index.html  →  signup.html  →  [email arrives]  →  click activation link
                                                          ↓
                                                     login.html
                                                          ↓
                                                   simulator.html
                                                  (auth check runs)
                                                          ↓
                                              wind_simulator_v9_6.html
                                              (loaded in iframe only if authed)
```

---

## Optional enhancements (future)

- **Server-side auth check**: Move to a Node/Python server so the HTTP request for the simulator file itself is refused without a valid session cookie — adds another layer on top of the JS check.
- **Usage limits**: Use Supabase Row Level Security + a `simulations` table to track usage per user.
- **Team accounts**: Add an `organizations` table and invite flow.
- **Password reset**: Add a `reset.html` page that calls `sb.auth.resetPasswordForEmail()`.
