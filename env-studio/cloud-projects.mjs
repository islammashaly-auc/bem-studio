// Uses the same public Supabase client configuration as the BEM Studio login.
const client = window.supabase.createClient(
  'https://ozcfpvwgvpclvagefhnk.supabase.co',
  'sb_publishable_DWOx7lVVcDUtrlFGjQEgbQ_uHhUistO',
);
const login = '../login.html?next=env-studio';
const table = 'env_studio_preview_projects';
const panel = document.createElement('div');
const status = document.createElement('span');
status.setAttribute('role', 'status');
const projects = document.createElement('select');
projects.setAttribute('aria-label', 'Cloud projects');
const open = document.createElement('button');
open.textContent = 'Open cloud project';
const signOut = document.createElement('button');
signOut.textContent = 'Sign out';
panel.style.cssText = 'position:fixed;bottom:0;right:0;z-index:9999;background:#141820;color:#e6edf7;padding:6px;display:flex;gap:8px;align-items:center';
panel.append(status, projects, open, signOut);
document.body.append(panel);

const { data: { user } } = await client.auth.getUser();
if (!user) {
  location.replace(login);
} else {
  window.configurePreviewAccount(user.id);
  document.documentElement.style.visibility = '';
  setup(user);
}

function setup(user) {
  let active = null;
  let saving = false;
  let opening = false;
  const defaultOption = () => new Option('Cloud projects', '');
  const snapshot = () => JSON.stringify({ ...window.collectState(), projectName });
  const reset = () => {
    active = { id: crypto.randomUUID(), revision: 0, saved: snapshot(), pending: null };
    status.textContent = 'Cloud autosave ready';
  };
  for (const name of ['startProject', 'applyState']) {
    const original = window[name];
    window[name] = (...args) => {
      const result = original(...args);
      reset();
      return result;
    };
  }
  const showWelcome = window.showWelcomeOverlay;
  window.showWelcomeOverlay = (...args) => {
    active = null;
    return showWelcome(...args);
  };

  async function refresh() {
    const { data, error } = await client.from(table).select('id,name')
      .eq('user_id', user.id).order('updated_at', { ascending: false });
    if (error) {
      status.textContent = 'Cloud project list unavailable';
      return;
    }
    const selected = projects.value;
    projects.replaceChildren(defaultOption(), ...data.map(row => new Option(row.name, row.id)));
    if (data.some(row => row.id === selected)) projects.value = selected;
  }

  async function save() {
    const project = active;
    if (!project || saving || project.conflict) return;
    const latest = snapshot();
    if (latest === project.saved) {
      project.pending = null;
      return;
    }
    if (latest !== project.pending) {
      project.pending = latest;
      project.changedAt = Date.now();
      status.textContent = 'Cloud changes pending';
      return;
    }
    if (Date.now() - project.changedAt < 2500) return;
    saving = true;
    const data = JSON.parse(latest);
    const row = { name: data.projectName, data, revision: project.revision + 1, updated_at: new Date().toISOString() };
    try {
      const query = project.revision
        ? client.from(table).update(row).eq('id', project.id).eq('revision', project.revision)
        : client.from(table).insert({ ...row, id: project.id, user_id: user.id });
      const { data: saved, error } = await query.select('id').maybeSingle();
      if (error) throw error;
      if (!saved) {
        project.conflict = true;
        if (project === active) status.textContent = 'Changed on another device. Export JSON before reopening.';
        return;
      }
      project.revision++;
      project.saved = latest;
      if (project === active) status.textContent = 'Saved to cloud';
      await refresh();
    } catch {
      if (project === active) status.textContent = 'Cloud save failed. Retrying…';
    } finally {
      saving = false;
    }
  }

  open.onclick = async () => {
    if (!projects.value || opening || saving) return;
    if (active && snapshot() !== active.saved && !confirm('Open another project and discard unsaved changes?')) return;
    opening = true;
    try {
      const { data, error } = await client.from(table).select('id,name,data,revision')
        .eq('id', projects.value).single();
      if (error) throw error;
      window.hideWelcomeOverlay();
      window.applyState(data.data);
      window.setProjectName(data.name);
      active = { id: data.id, revision: data.revision, saved: snapshot(), pending: null };
      status.textContent = 'Opened cloud project';
    } catch {
      status.textContent = 'Could not open cloud project';
    } finally {
      opening = false;
    }
  };
  signOut.onclick = async () => {
    if (active && snapshot() !== active.saved && !confirm('Sign out with unsaved cloud changes?')) return;
    const { error } = await client.auth.signOut();
    if (error) status.textContent = 'Sign-out failed';
  };
  client.auth.onAuthStateChange(event => {
    if (event === 'SIGNED_OUT') location.replace(login);
  });
  window.addEventListener('beforeunload', event => {
    if (active && snapshot() !== active.saved) event.preventDefault();
  });
  setInterval(() => { if (!opening) void save(); }, 1000);
  void refresh();
}
