# ENV Studio deploy preview

Open a pull request against `main` and append `/env-studio/` to its Netlify Deploy Preview URL. The existing homepage and WindFlow entry point stay available. Use an existing verified BEM Studio account for testing.

Before testing cloud saves, apply [the preview migration](supabase/env-studio-preview.sql) once in the existing Supabase project. It creates a dedicated table with per-account access policies. The existing WindFlow table and authentication settings are unchanged.

Create a project and edit the model. After “Saved to cloud” appears, open the preview in a second browser, log in, and reopen it from the cloud project list. Confirm another account cannot list or open it. Verify that an existing WindFlow project still opens via the original simulator.

The app bundle was generated with `npm run build:web` in the ENV Studio development checkout. Preview-specific changes are in `env-studio/index.html` and `env-studio/cloud-projects.mjs`. The preview syncs the app's serialized project data. Verify separately which uploaded inputs and simulation outputs are included before promising they sync.
