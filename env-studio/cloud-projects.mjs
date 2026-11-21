// Uses the same public Supabase client configuration as the BEM Studio login.
const client = window.supabase.createClient(
  'https://ozcfpvwgvpclvagefhnk.supabase.co',
  'sb_publishable_DWOx7lVVcDUtrlFGjQEgbQ_uHhUistO',
);
const login = '../login.html?next=env-studio';
const table = 'env_studio_preview_projects';
const status = document.getElementById('cloud-save-status');
const dialog = document.getElementById('cloud-project-dialog');
const lists = ['welcome-cloud-projects', 'file-cloud-projects']
  .map(id => document.getElementById(id));

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
    const { data, error } = await client.from(table).select('id,name,updated_at')
      .eq('user_id', user.id).order('updated_at', { ascending: false });
    for (const list of lists) {
      if (error || !data.length) {
        list.textContent = error ? 'Cloud projects unavailable.' : 'No cloud projects yet.';
        continue;
      }
      list.replaceChildren(...data.map(project => {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'wrecent-item';
        const name = document.createElement('span');
        name.className = 'wri-name';
        name.textContent = project.name;
        const date = document.createElement('span');
        date.className = 'wri-meta';
        date.textContent = new Date(project.updated_at).toLocaleDateString();
        button.append(name, date);
        button.onclick = () => void openProject(project.id);
        return button;
      }));
    }
  }

  async function save(immediate = false) {
    const project = active;
    if (!project || opening || saving || project.conflict) return;
    const latest = snapshot();
    if (latest === project.saved && (!immediate || project.revision)) {
      project.pending = null;
      return;
    }
    if (!immediate && latest !== project.pending) {
      project.pending = latest;
      project.changedAt = Date.now();
      status.textContent = 'Cloud changes pending';
      return;
    }
    if (!immediate && Date.now() - project.changedAt < 2500) return;
    saving = true;
    status.textContent = 'Saving to cloud…';
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

  async function openProject(id) {
    if (opening || saving) return;
    if (active && snapshot() !== active.saved && !confirm('Open another project and discard unsaved changes?')) return;
    opening = true;
    try {
      const { data, error } = await client.from(table).select('id,name,data,revision')
        .eq('id', id).single();
      if (error) throw error;
      window.applyState(data.data);
      window.setProjectName(data.name);
      active = { id: data.id, revision: data.revision, saved: snapshot(), pending: null };
      dialog.close();
      window.hideWelcomeOverlay();
      status.textContent = 'Saved to cloud';
    } catch {
      status.textContent = 'Could not open cloud project';
      window.flashHint('Could not open cloud project', 'warning');
    } finally {
      opening = false;
    }
  }
  document.getElementById('cloud-open-menu').onclick = () => {
    window.closeMenus();
    dialog.showModal();
    void refresh();
  };
  document.getElementById('cloud-save-menu').onclick = () => {
    window.closeMenus();
    void save(true);
  };
  document.getElementById('cloud-sign-out').onclick = async () => {
    window.closeMenus();
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
