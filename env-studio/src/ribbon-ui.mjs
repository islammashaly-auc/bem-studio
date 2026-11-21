const TABS = new Set(['model', 'energy', 'daylight', 'solar', 'wind', 'view', 'selection']);
const PHYSICS_TABS = new Set(['energy', 'daylight', 'solar', 'wind']);

const GROUPS = {
  model: ['Select', 'Walls', 'Openings', 'Roof and slab', 'Shading and objects', 'Site', 'Modify'],
  energy: {
    constructions: ['Library', 'Opaque assemblies', 'Glazing', 'Doors', 'Exchange'],
    activity: ['Library', 'Gains', 'Air', 'Schedules'],
    hvac: ['Library', 'System', 'Set points', 'Airflow', 'Plant'],
    schedules: ['Library', 'Schedule', 'Hourly profile'],
    compliance: ['Standard', 'Project', 'Pathway', 'Report'],
  },
  daylight: ['Sensor grid', 'Surface reflectance', 'Glass and ground', 'Climate', 'Display'],
  solar: ['Result period', 'Spatial grid', 'Scene', 'PV potential', 'Display scale'],
  wind: ['Source', 'Direction', 'Flow', 'Analysis tools', 'Display'],
  view: ['View', 'Camera', 'Show on the plan', 'Panels'],
  selection: ['Selected', 'Assembly', 'Edit', 'Show'],
};

const ENERGY_PANEL_TAB = {
  constructions: 'constructions',
  activity: 'internal',
  hvac: 'hvac',
  schedules: 'schedules',
};

const MODEL_COMMANDS = {
  Select: [
    { id:'select', label:'Select', hotkey:'S', icon:'lucide-mouse-pointer', tool:'select' },
  ],
  Walls: [
    { id:'wall', label:'Wall', hotkey:'W', icon:'lucide-brick-wall', tool:'wall' },
    { id:'partition', label:'Partition', hotkey:'R', icon:'lucide-panel-bottom-dashed', tool:'partition' },
  ],
  Openings: [
    { id:'window', label:'Window', hotkey:'O', icon:'lucide-mirror-rectangular', tool:'opening', openingMode:'window' },
    { id:'door', label:'Door', hotkey:'O', icon:'lucide-door-open', tool:'opening', openingMode:'door' },
    { id:'hole', label:'Hole', hotkey:'O', icon:'lucide-square-dashed', tool:'opening', openingMode:'hole' },
  ],
  'Roof and slab': [
    { id:'skylight', label:'Skylight', hotkey:'K', icon:'lucide-grid-2x2', tool:'skylight' },
    { id:'surf-opening', label:'Roof/slab opening', hotkey:'F', icon:'lucide-triangle-dashed', tool:'surf-opening' },
  ],
  'Shading and objects': [
    { id:'shade', label:'Shading', hotkey:'H', icon:'lucide-blinds', tool:'shade' },
    { id:'pergola', label:'Pergola', hotkey:'P', icon:'lucide-parasol', tool:'pergola' },
    { id:'component', label:'Component block', hotkey:'C', icon:'lucide-cuboid', tool:'component' },
  ],
  Site: [
    { id:'wind-tree', label:'Tree', hotkey:'T', icon:'lucide-trees', tool:'wind-tree' },
    { id:'wind-screen', label:'Wind screen', hotkey:'N', icon:'lucide-wind-arrow-down', tool:'wind-screen' },
  ],
};

const MODIFY_COMMANDS = [
  { label:'Move', hotkey:'Ctrl+X', icon:'lucide-move', action:() => window.beginMove2D?.() },
  { label:'Rotate', hotkey:'Ctrl+R', icon:'lucide-refresh-ccw-dot', action:() => window.beginRotate?.() },
  { label:'Scale', hotkey:'Ctrl+L', icon:'lucide-image-upscale', action:() => window.beginScale?.() },
  { label:'Copy', hotkey:'Ctrl+C', icon:'lucide-copy', action:() => window.beginCopy2D?.() },
  { label:'Paste', hotkey:'Ctrl+V', icon:'lucide-clipboard-paste', action:() => window.beginPaste2D?.() },
  { label:'Delete', hotkey:'Del', icon:'lucide-trash-2', danger:true, action:() => window.triggerDeleteSelection?.() },
];

const state = {
  activeTab: 'model',
  previousTab: 'model',
  activeEnergySubtab: 'constructions',
  activeTool: window.getActiveTool?.() || 'select',
  selection: { count: 0, label: 'Nothing selected', detail: '' },
};

const tabButtons = [...document.querySelectorAll('[data-ribbon-tab]')];
const energyButtons = [...document.querySelectorAll('[data-energy-subtab]')];
const energyStrip = document.getElementById('energy-subtabs');
const groupsHost = document.getElementById('ribbon-groups');
const runGroup = document.getElementById('ribbon-run-group');
const selectionTab = document.getElementById('ribbon-tab-selection');
const selectionCount = document.getElementById('ribbon-selection-count');
const toolOptions = document.getElementById('model-tool-options');

function slug(value) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function groupNames() {
  if (state.activeTab === 'energy') return GROUPS.energy[state.activeEnergySubtab];
  return GROUPS[state.activeTab] || [];
}

function icon(symbol, className = '') {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', `lucide-icon ${className}`.trim());
  svg.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  svg.append(use);
  return svg;
}

function commandIsActive(command, toolState) {
  if (command.tool !== toolState.tool) return false;
  if (command.openingMode) return command.openingMode === toolState.openingMode;
  return true;
}

function runModelCommand(command) {
  if (command.openingMode) window.setOpeningMode?.(command.openingMode);
  window.setTool?.(command.tool);
  syncTool(command.tool);
}

function appendModelGroupContent(group, name) {
  group.classList.add('ribbon-model-group');
  const toolState = window.getRibbonToolState?.() || { tool:state.activeTool };
  if (name === 'Modify') {
    const grid = document.createElement('div');
    grid.className = 'ribbon-compact-grid';
    MODIFY_COMMANDS.forEach(command => {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = `ribbon-compact-command${command.danger ? ' danger' : ''}`;
      button.title = `${command.label} · ${command.hotkey}`;
      button.setAttribute('aria-label', button.title);
      button.append(icon(command.icon));
      button.addEventListener('click', command.action);
      grid.append(button);
    });
    group.append(grid);
    return;
  }

  (MODEL_COMMANDS[name] || []).forEach(command => {
    const button = document.createElement('button');
    button.type = 'button';
    button.id = `ribbon-tool-${command.id}`;
    button.className = 'ribbon-command';
    if (command.id === 'component') button.classList.add('ribbon-command-wide', 'ribbon-command-two-line');
    button.classList.toggle('active', commandIsActive(command, toolState));
    button.setAttribute('aria-pressed', String(commandIsActive(command, toolState)));
    button.title = `${command.label} · ${command.hotkey}`;
    const hotkey = document.createElement('span');
    hotkey.className = 'ribbon-hotkey';
    hotkey.textContent = command.hotkey;
    const label = document.createElement('span');
    label.className = 'ribbon-command-label';
    label.textContent = command.label;
    button.append(hotkey, icon(command.icon, 'ribbon-command-icon'), label);
    button.addEventListener('click', () => runModelCommand(command));
    group.append(button);
  });
}

function selectionCommand(group, label, symbol, action, {disabled = false, pressed} = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ribbon-command';
  button.disabled = disabled;
  const caption = document.createElement('span');
  caption.className = 'ribbon-command-label';
  caption.textContent = label;
  button.append(icon(symbol, 'ribbon-command-icon'), caption);
  if (pressed !== undefined) {
    button.setAttribute('aria-pressed', String(pressed));
    button.classList.toggle('active', pressed);
  }
  button.addEventListener('click', action);
  group.append(button);
  return button;
}

function renderSelectionGroup(group, name) {
  if (name === 'Selected') {
    const summary = document.createElement('div');
    summary.className = 'ribbon-selection-summary';
    const title = document.createElement('strong');
    title.textContent = state.selection.label;
    const detail = document.createElement('span');
    detail.textContent = state.selection.detail || `${state.selection.count} selected`;
    const symbol = {Window:'lucide-mirror-rectangular', Door:'lucide-door-open', Skylight:'lucide-grid-2x2',
      Wall:'lucide-brick-wall', Zone:'ribbon-zone', Component:'lucide-cuboid'}[state.selection.label.replace(/s$/, '')] || 'lucide-mouse-pointer';
    summary.append(icon(symbol), title, detail);
    group.append(summary);
  } else if (name === 'Assembly') {
    const assembly = window.getRibbonSelectionAssembly();
    const summary = document.createElement('div');
    summary.className = 'ribbon-selection-assembly';
    const title = document.createElement('strong');
    const source = document.createElement('small');
    title.textContent = assembly?.name || 'No shared assembly';
    source.textContent = assembly?.numericOverride ? `${assembly.source} · local thermal values` : assembly?.source || '';
    summary.append(title, source);
    group.append(summary);
    const select = document.createElement('select');
    select.hidden = true;
    select.setAttribute('aria-label','Assembly override');
    select.add(new Option('Choose an assembly…',''));
    for (const entry of assembly?.assignments || []) select.add(new Option(entry.name,entry.id));
    select.addEventListener('change', () => { if (select.value) window.ribbonApplySelectionAssembly(select.value); });
    summary.append(select);
    const override = selectionCommand(group,'Override here','lucide-layers-2',() => {
      select.hidden = !select.hidden;
      override.setAttribute('aria-expanded', String(!select.hidden));
      if (!select.hidden) select.focus();
    }, {disabled:!assembly?.assignments.length});
    override.setAttribute('aria-expanded','false');
    selectionCommand(group,'Reset','lucide-refresh-ccw-dot',() => window.ribbonApplySelectionAssembly(''),{disabled:!assembly?.local});
  } else if (name === 'Edit') {
    for (const command of MODIFY_COMMANDS.filter(item => ['Move','Copy','Rotate','Delete'].includes(item.label))) {
      const button = selectionCommand(group,command.label,command.icon,command.action);
      button.title = `${command.label} · ${command.hotkey}`;
      const badge = document.createElement('span');
      badge.className = 'ribbon-hotkey';
      badge.textContent = command.hotkey;
      badge.setAttribute('aria-hidden','true');
      button.append(badge);
    }
  } else if (name === 'Show') {
    const actions = window.getRibbonSelectionActions();
    selectionCommand(group,'Isolate','ribbon-tab-view',() => window.ribbonToggleSelectionIsolation(),
      {disabled:!actions.geometry,pressed:actions.isolated});
    selectionCommand(group,'Zoom to','ribbon-fit',() => window.ribbonZoomToSelection(),{disabled:!actions.geometry});
    selectionCommand(group,'In Browser','ribbon-building',() => window.ribbonRevealSelectionInBrowser(),{disabled:!actions.inBrowser});
  }
}

function renderGroups() {
  if (!groupsHost) return;
  groupsHost.replaceChildren();
  groupNames().forEach(name => {
    const group = document.createElement('section');
    group.className = 'ribbon-group';
    group.dataset.ribbonGroup = slug(name);
    group.setAttribute('aria-label', name);

    if (state.activeTab === 'model') {
      appendModelGroupContent(group, name);
    } else if (state.activeTab === 'selection') {
      renderSelectionGroup(group, name);
    } else window.envAnalysisRibbon?.renderGroup(group, state.activeTab, state.activeEnergySubtab, name);

    const label = document.createElement('span');
    label.className = 'ribbon-group-label';
    label.textContent = name;
    group.append(label);
    groupsHost.append(group);
  });
}

function optionSet(label, choices, activeValue, apply) {
  const set = document.createElement('div');
  set.className = 'model-option-set';
  const title = document.createElement('span');
  title.className = 'model-option-label';
  title.textContent = label;
  const buttons = document.createElement('div');
  buttons.className = 'model-option-choices';
  choices.forEach(choice => {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'model-option-choice';
    button.classList.toggle('active', choice.value === activeValue);
    button.setAttribute('aria-pressed', String(choice.value === activeValue));
    button.textContent = choice.label;
    button.addEventListener('click', () => {
      apply(choice.value);
      syncToolOptions();
    });
    buttons.append(button);
  });
  set.append(title, buttons);
  return set;
}

function optionInfo(text) {
  const info = document.createElement('div');
  info.className = 'model-options-info';
  const badge = document.createElement('span');
  badge.className = 'model-options-info-icon';
  badge.textContent = 'i';
  const copy = document.createElement('span');
  copy.textContent = text;
  info.append(badge, copy);
  return info;
}

function renderToolOptions() {
  if (!toolOptions) return;
  const toolState = window.getRibbonToolState?.() || { tool:state.activeTool };
  const tool = toolState.tool;
  const fragments = [];
  let title = '';

  if (tool === 'wall') {
    title = 'Wall options';
    fragments.push(optionSet('Mode', [
      {value:'polygon',label:'Poly'}, {value:'rect',label:'Rect'},
    ], toolState.wallMode, value => window.setWallMode?.(value)));
    fragments.push(optionSet('Segment', [
      {value:'straight',label:'Straight'}, {value:'curve',label:'Curve · 3 pt'},
    ], toolState.wallSegmentMode, value => window.setWallSegmentMode?.(value)));
  } else if (tool === 'opening') {
    title = 'Opening options';
    fragments.push(optionSet('Type', [
      {value:'window',label:'Window'}, {value:'door',label:'Door'}, {value:'hole',label:'Hole'},
    ], toolState.openingMode, value => window.setOpeningMode?.(value)));
    fragments.push(optionInfo('Host wall or slab is detected from where you draw.'));
  } else if (tool === 'skylight') {
    title = 'Skylight options';
    fragments.push(optionSet('Shape', [
      {value:'rect',label:'Rect'}, {value:'polygon',label:'Poly'}, {value:'circle',label:'Circle'},
    ], toolState.skylightMode, value => window.setSkylightMode?.(value)));
  } else if (tool === 'surf-opening') {
    title = 'Roof and slab opening';
    fragments.push(optionSet('Shape', [
      {value:'rect',label:'Rect'}, {value:'polygon',label:'Poly'}, {value:'circle',label:'Circle'},
    ], toolState.skylightMode, value => window.setSkylightMode?.(value)));
    fragments.push(optionSet('Target', [
      {value:'roof',label:'Roof'}, {value:'floor',label:'Slab'}, {value:'shaft',label:'Shaft'},
    ], toolState.openingTarget, value => window.setOpeningTarget?.(value)));
  } else if (tool === 'shade') {
    title = 'Shading options';
    fragments.push(optionSet('Type', [
      {value:'overhang',label:'Overhang'}, {value:'box',label:'Box'}, {value:'fin',label:'Fin'},
    ], toolState.shadeMode, value => window.setShadeMode?.(value)));
  } else if (tool === 'pergola') {
    title = 'Pergola options';
    fragments.push(optionSet('Pergola', [
      {value:'horizontal',label:'Horizontal'}, {value:'vertical',label:'Vertical'},
    ], toolState.pergolaMode, value => window.setPergolaMode?.(value)));
  } else if (tool === 'component') {
    title = 'Component block options';
    fragments.push(optionSet('Block', [
      {value:'rect',label:'Rect'}, {value:'polygon',label:'Poly'}, {value:'circle',label:'Circle'},
    ], toolState.componentMode, value => window.setComponentMode?.(value)));
  } else if (tool === 'wind-tree') {
    title = 'Tree options';
    fragments.push(optionSet('Density', [
      {value:'high',label:'Dense'}, {value:'med',label:'Medium'}, {value:'low',label:'Light'},
    ], toolState.windTreePerm, value => window.setWindTreePerm?.(value)));
  } else if (tool === 'wind-screen') {
    title = 'Wind screen options';
    fragments.push(optionSet('Open', [
      {value:'25',label:'25%'}, {value:'50',label:'50%'}, {value:'75',label:'75%'},
    ], toolState.windScreenPerm, value => window.setWindScreenPerm?.(value)));
  }

  const visible = state.activeTab === 'model' && !!title;
  toolOptions.hidden = !visible;
  toolOptions.replaceChildren();
  if (!visible) return;
  const titleNode = document.createElement('strong');
  titleNode.className = 'model-options-title';
  titleNode.textContent = title;
  const hint = document.createElement('span');
  hint.className = 'model-options-hint';
  hint.textContent = toolState.hint || '';
  toolOptions.append(titleNode, ...fragments, hint);
}

function syncToolOptions() {
  if (state.activeTab === 'model') renderToolOptions();
  if (state.activeTab === 'model') renderGroups();
}

function syncTool(tool = window.getActiveTool?.() || 'select') {
  state.activeTool = tool;
  if (state.activeTab === 'model') {
    renderGroups();
    renderToolOptions();
  }
}

function revealTool(tool = window.getActiveTool?.() || 'select') {
  state.activeTool = tool;
  activateTab('model', { callEngine:false });
}

function updateTabs() {
  tabButtons.forEach(button => {
    const active = button.dataset.ribbonTab === state.activeTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
    button.tabIndex = active ? 0 : -1;
  });
  energyButtons.forEach(button => {
    const active = button.dataset.energySubtab === state.activeEnergySubtab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function activateEnergySubtab(subtab, { callEngine = true } = {}) {
  if (!Object.hasOwn(GROUPS.energy, subtab)) return;
  window.envAnalysisRibbon?.subtabChanged?.();
  state.activeEnergySubtab = subtab;
  updateTabs();
  if (state.activeTab === 'energy') renderGroups();
  const panelTab = ENERGY_PANEL_TAB[subtab];
  const scopeKind = window.getEnergyBrowserSelection?.().kind || 'building';
  const panelScope = scopeKind === 'building' ? 'defaults' : 'zone';
  if (callEngine && panelTab) window.enSetSettingsTab?.(panelScope, panelTab);
  window.envAnalysisRibbon?.syncCompliance?.();
}

function activateTab(tab, { callEngine = true, remember = true } = {}) {
  if (!TABS.has(tab) || (tab === 'selection' && !state.selection.count)) return;
  if (remember && tab !== 'selection' && state.activeTab !== tab) state.previousTab = tab;
  state.activeTab = tab;

  document.body.dataset.ribbonTab = tab;
  document.body.classList.toggle('ribbon-physics-active', PHYSICS_TABS.has(tab));
  if (energyStrip) energyStrip.hidden = tab !== 'energy';
  if (runGroup) runGroup.hidden = !PHYSICS_TABS.has(tab);
  updateTabs();
  renderGroups();
  renderToolOptions();
  window.envAnalysisRibbon?.tabChanged?.(tab);

  if (callEngine && PHYSICS_TABS.has(tab)) window.switchPhysicsTab?.(tab);
  if (callEngine && tab === 'energy') activateEnergySubtab(state.activeEnergySubtab);
  requestAnimationFrame(() => window.dispatchEvent(new Event('resize')));
}

function syncPhysics(tab) {
  if (!PHYSICS_TABS.has(tab)) return;
  activateTab(tab, { callEngine: false });
}

function syncSelection(summary = {}) {
  const previousCount = state.selection.count;
  const count = Math.max(0, Number(summary.count) || 0);
  state.selection = {
    count,
    label: String(summary.label || (count === 1 ? '1 item' : `${count} items`)),
    detail: String(summary.detail || ''),
  };

  if (selectionTab) selectionTab.hidden = count === 0;
  if (selectionCount) selectionCount.textContent = count > 99 ? '99+' : String(count);

  if (!previousCount && count) {
    if (state.activeTab !== 'selection') state.previousTab = state.activeTab;
    activateTab('selection', { callEngine: false, remember: false });
  } else if (previousCount && !count && state.activeTab === 'selection') {
    const fallback = TABS.has(state.previousTab) && state.previousTab !== 'selection'
      ? state.previousTab : 'model';
    // The physics engine remained on the same module while Selection was
    // contextual, so restoring its ribbon must not re-trigger tab side effects.
    activateTab(fallback, { callEngine: false, remember: false });
  } else if (state.activeTab === 'selection') {
    renderGroups();
  }
}

function moveTabFocus(current, direction) {
  const visible = tabButtons.filter(button => !button.hidden);
  const index = visible.indexOf(current);
  const next = visible[(index + direction + visible.length) % visible.length];
  next?.focus();
}

tabButtons.forEach(button => {
  button.addEventListener('click', () => activateTab(button.dataset.ribbonTab));
  button.addEventListener('keydown', event => {
    if (event.key === 'ArrowRight') { event.preventDefault(); moveTabFocus(button, 1); }
    if (event.key === 'ArrowLeft') { event.preventDefault(); moveTabFocus(button, -1); }
  });
});
energyButtons.forEach(button => {
  button.addEventListener('click', () => activateEnergySubtab(button.dataset.energySubtab));
});
window.addEventListener('env-browser-scope-change', () => {
  if (state.activeTab === 'energy') activateEnergySubtab(state.activeEnergySubtab);
});

window.envRibbonUI = {
  activateTab,
  activateEnergySubtab,
  syncPhysics,
  syncSelection,
  syncTool,
  syncToolOptions,
  revealTool,
  refresh: renderGroups,
  getState: () => ({ ...state, selection: { ...state.selection } }),
};

activateTab('model', { callEngine: false, remember: false });
syncSelection(window.getRibbonSelectionSummary?.());
