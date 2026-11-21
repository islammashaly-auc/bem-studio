import {renderComplianceGroup,syncCompliance} from './compliance-ribbon.mjs';
import {resultsDrawer} from './results-drawer.mjs';
import {bindDrawerHandle} from './drawer-handle.mjs';
// Move the live settings nodes into transient editors. Their IDs, listeners,
// and inline engine handlers stay intact, including worker progress updates.
const homes = new Map();
const panel = document.createElement('section');
panel.className = 'analysis-command-editor';
panel.hidden = true;
panel.innerHTML = '<header><strong></strong><button type="button" aria-label="Close editor">×</button></header><div class="analysis-command-content"></div>';
document.body.append(panel);
const content = panel.lastElementChild;
const scopeFooter=document.createElement('footer');scopeFooter.className='analysis-scope-footer';scopeFooter.hidden=true;panel.append(scopeFooter);
const drawerHandle = document.createElement('button');
drawerHandle.type = 'button';
drawerHandle.className = 'analysis-editor-handle';
drawerHandle.setAttribute('aria-label','Resize construction drawer');
drawerHandle.title = 'Drag to resize';
drawerHandle.hidden = true;
panel.append(drawerHandle);
let startDrawerWidth;
function resizeConstructionDrawer(delta, starting) {
  if (starting) startDrawerWidth = panel.offsetWidth;
  const width = Math.min(innerWidth - 25, 720, Math.max(280, startDrawerWidth + delta));
  panel.style.setProperty('--construction-drawer-width', `${width}px`);
}
bindDrawerHandle(drawerHandle,(dx,_dy,starting)=>resizeConstructionDrawer(-dx,starting));
drawerHandle.addEventListener('keydown',event=>{
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  resizeConstructionDrawer(event.key === 'ArrowLeft' ? 24 : -24,true);
});
let scheduleKey='occupancy';
let scheduleDay='weekday';
let currentEditor = null;
let lastPhysics='energy';
let viewSettings=false;
function syncViewButtons() {
  for(const button of document.querySelectorAll('.ribbon-command')) {
    const label=button.querySelector('.ribbon-command-label')?.textContent;
    const active=label==='Settings panel'?viewSettings:label==='Results'?resultsDrawer.expanded:label==='Browser'?window.getRibbonViewState().Browser:null;
    if(active!=null){button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
  }
}
function toggleSettings(anchor) {
  if(viewSettings){close();return;}
  open('Settings panel',[`${lastPhysics}-panels`],anchor,true);
  viewSettings=true;syncViewButtons();
}
function toggleResults() {
  resultsDrawer.toggle();
}
function close() {
  for (const [node, marker] of homes) { if (marker.isConnected) marker.replaceWith(marker.restoreCard || node); }
  homes.clear(); content.replaceChildren(); panel.hidden = true;
  currentEditor = null;
  panel.classList.remove('construction-drawer');
  drawerHandle.hidden = true;
  scopeFooter.hidden=true;window.ribbonSetAssemblyTint?.(null);
  viewSettings=false;syncViewButtons();
  syncConstructionCommands();
}
panel.querySelector('button').onclick = close;
function updateScopeFooter() {
  const scope=window.ribbonEnergyScopeSummary();
  scopeFooter.hidden=window.envRibbonUI.getState().activeTab!=='energy';
  scopeFooter.replaceChildren();
  if(scopeFooter.hidden)return;
  const label=document.createElement('span');label.textContent=`${scope.name}${scope.kind==='level'?` · ${scope.count} zones`:''}`;
  const reset=document.createElement('button');reset.type='button';reset.textContent=scope.kind==='building'?'Reset to defaults':scope.kind==='opening'?'Reset to inherited':'Reset to building';
  reset.title=scope.kind==='level'||scope.kind==='zone'?'Reset zone constructions, gains, HVAC and schedules. Individual opening and wall overrides remain.':'Reset Energy settings at this scope';
  reset.onclick=()=>{
    const editor = currentEditor;
    window.ribbonResetEnergyScope();
    window.envRibbonUI.refresh();
    if (editor?.mode === 'scope') openScopeDrawer();
    else if (editor?.mode === 'construction') openConstructionDrawer(editor.type,editor.anchor);
    else close();
  };
  scopeFooter.append(label,reset);
  if (panel.classList.contains('construction-drawer')) {
    const pin = document.createElement('button');
    pin.type = 'button';
    pin.textContent = constructionPinned ? 'Unpin' : 'Pin';
    pin.setAttribute('aria-label',constructionPinned ? 'Unpin construction drawer' : 'Pin construction drawer');
    pin.onclick = () => {
      constructionPinned = !constructionPinned;
      positionConstructionDrawer(currentEditor?.anchor);
      updateScopeFooter();
    };
    scopeFooter.append(pin);
  }
}
function open(title, ids, anchor, dock = false, tintType = null) {
  close(); panel.querySelector('strong').textContent = title;
  currentEditor = {title, ids, anchor, dock,tintType};
  ids.forEach(id => {
    const node = document.getElementById(id);
    if (!node) return;
    const marker = document.createComment(`home:${id}`);
    node.before(marker); homes.set(node, marker); content.append(node);
    node.classList.remove('collapsed');
  });
  panel.classList.toggle('docked', dock); panel.hidden = false;
  const box = anchor.getBoundingClientRect();
  panel.style.top = `${dock ? document.querySelector('.body').getBoundingClientRect().top + 10 : box.bottom + 5}px`;
  panel.style.left = dock ? 'auto' : `${Math.min(box.left, innerWidth - 390)}px`;
  updateScopeFooter();window.ribbonSetAssemblyTint?.(tintType);
}
document.addEventListener('keydown', event => { if (event.key === 'Escape') close(); });
document.addEventListener('pointerdown', event => {
  if (!panel.hidden && !panel.classList.contains('docked') && !panel.contains(event.target) && !event.target.closest('.ribbon-command')) close();
});
function liveControl(group, id, label) {
  const source = document.getElementById(id);
  if (!source) return;
  const field = document.createElement('label'); field.className = 'ribbon-live-field';
  const caption = document.createElement('span'); caption.textContent = label;
  const control = source.cloneNode(true);
  control.removeAttribute('id'); control.removeAttribute('oninput'); control.removeAttribute('onchange');
  control.removeAttribute('onclick'); control.removeAttribute('onkeydown'); control.style.cssText = '';
  control.value = source.value; control.checked = source.checked;
  control.dataset.sourceControl=id;
  if(id==='s-deg')control.type='number';
  if(id==='dl-view-mode')for(const option of control.options){
    option.title=option.textContent;
    option.textContent=({sda:'sDA',ase:'ASE',udi:'UDI',action:'Action map',pit:'Point in time','pit-banded':'Point in time · bands'})[option.value] || option.textContent;
  }
  const output = document.createElement('output');
  const update = () => { output.textContent = control.type === 'range' ? control.value : ''; };
  for (const type of ['input','change']) control.addEventListener(type, () => {
    const target = document.getElementById(id);
    if (!target) return;
    target.value = control.value; target.checked = control.checked;
    target.dispatchEvent(new Event(type,{bubbles:true})); update();
    if(type==='change' && ['wind-weather-period','wind-weather-season','wind-weather-date'].includes(id))window.envRibbonUI.activateTab('wind',{callEngine:false});
  });
  update(); field.append(caption,control);if(control.type==='range')field.append(output);group.append(field);
}
function selectField(group,label,options,value,apply) {
  const field=document.createElement('label');field.className='ribbon-live-field';
  const caption=document.createElement('span');caption.textContent=label;
  const select=document.createElement('select');select.setAttribute('aria-label',label);
  for(const [id,text] of options)select.add(new Option(text,id));select.value=String(value);
  select.onchange=()=>apply(select.value);field.append(caption,select);group.append(field);
}
function refreshEditor() {
  if (!currentEditor) return;
  if (currentEditor.mode === 'scope') { renderScopeDrawer(); return; }
  if (currentEditor.mode === 'construction') { refreshConstructionDrawer(); return; }
  // Construction cards are rebuilt by the engine after an assignment. Keep
  // the dock on the freshly rendered card instead of retaining an old node.
  const {title,ids,anchor,dock,tintType} = currentEditor;
  if (!dock) return;
  const fresh = ids.map(id => document.getElementById(id));
  if (fresh.every(node => !node || content.contains(node))) return;
  open(title,ids,anchor,dock,tintType);
}
function button(group, label, icon, action, disabled = false) {
  const b = document.createElement('button'); b.type = 'button'; b.className = 'ribbon-command';
  if (['Performance','Infiltration','Resolution','Dimensions','Reflectance'].includes(label)) b.classList.add('ribbon-command-wide');
  if (label === 'Site electricity') b.classList.add('ribbon-command-wide', 'ribbon-command-two-line');
  b.innerHTML = `<svg class="lucide-icon ribbon-command-icon" aria-hidden="true"><use href="#${icon}"/></svg><span class="ribbon-command-label"></span>`;
  b.lastElementChild.textContent = label; b.disabled = disabled; b.onclick = () => action(b);
  const hotkey=window.envRibbonUI?.getState().activeTab==='view'?({'2D':'2','3D':'3','Zone names':'Shift+Z',Grid:'Shift+G',Roof:'Shift+R','Archi mode':'Shift+A'})[label]:null;
  if(hotkey){const badge=document.createElement('span');badge.className='ribbon-hotkey';badge.textContent=hotkey;b.append(badge);b.title=`${label} · ${hotkey}`;}
  group.append(b); return b;
}
function editor(group, label, icon, ids, dock = false) { return button(group,label,icon,b => open(label,ids,b,dock)); }
function energyField(group, label, icon, key) {
  const prefix=energyScope()==='zone'?'zp':'en';
  const source=document.getElementById(`${prefix}-prop-${key}`);
  const b=button(group,label,icon,anchor=>{
    const current=document.getElementById(`${prefix}-prop-${key}`);
    const row=current?.closest('.srow');
    if(row){row.id=`ribbon-energy-field-${prefix}-${key}`;open(label,[row.id],anchor);}
  });
  const value=document.createElement('small');value.className='ribbon-command-value';
  value.textContent=source?.value || source?.placeholder || 'Inherited';b.append(value);
}
function energyScope() { return window.getEnergyBrowserSelection?.().kind === 'building' ? 'defaults' : 'zone'; }
function scheduleControls(group) {
  const scope=energyScope();
  const profile=window.getRibbonScheduleProfile?.(scope,scheduleKey);
  if(!profile)return;
  const box=document.createElement('div');box.className='ribbon-schedule-controls';
  const choices=document.createElement('div');choices.className='ribbon-schedule-choices';
  for(const [key,label] of [['hvac','HVAC'],['occupancy','Occupancy'],['lighting','Lighting'],['equipment','Equipment']]) {
    const b=document.createElement('button');b.type='button';b.textContent=label;b.classList.toggle('active',key===scheduleKey);b.setAttribute('aria-pressed',String(key===scheduleKey));
    b.onclick=()=>{scheduleKey=key;window.envRibbonUI.activateEnergySubtab('schedules',{callEngine:false});};choices.append(b);
  }
  const days=document.createElement('div');days.className='ribbon-schedule-choices';
  for(const [key,label] of [['weekday','Weekday'],['saturday','Saturday'],['sunday','Sunday']]) {
    const b=document.createElement('button');b.type='button';b.textContent=label;b.classList.toggle('active',key===scheduleDay);
    b.setAttribute('aria-pressed',String(key===scheduleDay));
    b.onclick=()=>{scheduleDay=key;window.envRibbonUI.activateEnergySubtab('schedules',{callEngine:false});};days.append(b);
  }
  const presets=document.createElement('select');presets.setAttribute('aria-label','Schedule preset');
  for(const [key,item] of Object.entries(window.ENERGY_SCHEDULE_PRESETS || {}))presets.add(new Option(item.label,key));
  if(profile.preset==='custom')presets.add(new Option(profile.name || 'Custom','custom'));
  presets.value=profile.preset;
  presets.onchange=()=>{window.enSelectSchedule(scope,scheduleKey,presets.value);window.envRibbonUI.activateEnergySubtab('schedules',{callEngine:false});};
  box.append(choices,days,presets);group.append(box);
}
function scheduleProfile(group) {
  const scope=energyScope();
  const profile=window.getRibbonScheduleProfile?.(scope,scheduleKey);
  if(!profile)return;
  const box=document.createElement('div');box.className='ribbon-schedule';
  const bars=document.createElement('div');bars.className='ribbon-schedule-bars';
  bars.setAttribute('role','group');bars.setAttribute('aria-label',`${scheduleKey} ${scheduleDay} hourly profile`);
  profile[scheduleDay].forEach((value,hour)=>{
    const bar=document.createElement('button');bar.type='button';bar.className='ribbon-schedule-bar';
    bar.setAttribute('role','slider');bar.setAttribute('aria-valuemin','0');bar.setAttribute('aria-valuemax','100');
    bar.setAttribute('aria-label',`${String(hour).padStart(2,'0')}:00–${String(hour+1).padStart(2,'0')}:00 schedule fraction`);
    const fill=document.createElement('span');bar.append(fill);
    let current=value,dragging=false;
    const paint=next=>{
      current=Math.round(Math.max(0,Math.min(1,next))*100)/100;
      fill.style.height=`${current*100}%`;
      bar.setAttribute('aria-valuenow',String(Math.round(current*100)));
      bar.setAttribute('aria-valuetext',`${Math.round(current*100)}%`);
      bar.title=`${String(hour).padStart(2,'0')}:00 · ${Math.round(current*100)}%`;
    };
    const commit=()=>{
      if(window.getRibbonScheduleProfile(scope,scheduleKey).preset!=='custom')window.enCustomizeSchedule(scope,scheduleKey);
      window.enUpdateScheduleHour(scope,scheduleKey,scheduleDay,hour,current);
      const presets=document.querySelector('.ribbon-schedule-controls select');
      if(presets){if(![...presets.options].some(option=>option.value==='custom'))presets.add(new Option('Custom','custom'));presets.value='custom';}
    };
    const pointerValue=event=>{const rect=bar.getBoundingClientRect();return Math.round((1-(event.clientY-rect.top)/rect.height)*20)/20;};
    bar.onpointerdown=event=>{if(event.button!==0)return;event.preventDefault();bar.focus();dragging=true;bar.setPointerCapture(event.pointerId);paint(pointerValue(event));};
    bar.onpointermove=event=>{if(dragging)paint(pointerValue(event));};
    bar.onpointerup=event=>{if(!dragging)return;paint(pointerValue(event));dragging=false;bar.releasePointerCapture(event.pointerId);commit();};
    bar.onpointercancel=()=>{dragging=false;paint(value);};
    bar.onkeydown=event=>{
      const next=({ArrowUp:current+.05,ArrowRight:current+.05,ArrowDown:current-.05,ArrowLeft:current-.05,PageUp:current+.1,PageDown:current-.1,Home:0,End:1})[event.key];
      if(next==null)return;event.preventDefault();paint(next);commit();
    };
    paint(value);bars.append(bar);
  });
  const axis=document.createElement('div');axis.className='ribbon-schedule-axis';
  for(const hour of [0,6,12,18,24]){const label=document.createElement('span');label.textContent=`${hour}h`;axis.append(label);}
  box.append(bars,axis);group.append(box);
}
const constructionTypes = [
  ['extWall','Ext wall','ribbon-cmd-ext-wall'],['roof','Roof','ribbon-cmd-roof'],
  ['interiorWall','Int wall','ribbon-cmd-int-wall'],['slab','Int slab','ribbon-cmd-int-slab'],
  ['exposedFloor','Ext slab','ribbon-cmd-ext-slab'],['groundFloor','Ground slab','ribbon-cmd-ground-slab'],
];
const drawerConstructionTypes = [
  ...constructionTypes,
  ['window','Windows','lucide-mirror-rectangular'],
  ['skylight','Skylight','lucide-grid-2x2'],
  ['door','Door','lucide-door-open'],
];
let constructionPinned = true;

function positionConstructionDrawer(anchor) {
  panel.classList.toggle('docked',constructionPinned);
  drawerHandle.hidden = !constructionPinned;
  const body = document.querySelector('.body').getBoundingClientRect();
  const box = anchor?.isConnected ? anchor.getBoundingClientRect() : null;
  panel.style.top = `${body.top + 10}px`;
  panel.style.setProperty('--construction-drawer-top',panel.style.top);
  panel.style.left = constructionPinned ? 'auto' :
    `${Math.max(12, Math.min(box?.left ?? body.left + 32, innerWidth - panel.offsetWidth - 12))}px`;
}

function beginConstructionEditor(title, state) {
  close();
  currentEditor = state;
  panel.querySelector('strong').textContent = title;
  panel.classList.add('construction-drawer');
  panel.hidden = false;
  positionConstructionDrawer(state.anchor);
  updateScopeFooter();
}

function scopeMarker(spec) {
  const marker = document.createElement('i');
  marker.className = 'browser-scope-dot';
  if (spec.localCount === spec.count) marker.classList.add('local');
  else if (spec.localCount) marker.classList.add('mixed');
  marker.title = spec.localCount === spec.count ? 'Set here' : spec.localCount ? 'Some zones override' : 'Inherited';
  marker.setAttribute('role','img');
  marker.setAttribute('aria-label',marker.title);
  return marker;
}

function makeAssemblySelect(type,label,spec,select = document.createElement('select'),update = null) {
  select.classList.add('adv-inp');
  select.setAttribute('aria-label', `${label} assembly`);
  select.innerHTML = spec.options;
  select.disabled = spec.readOnly;
  select.removeAttribute('onchange');
  select.onchange = () => {
    window.ribbonAssignScopedConstruction(type,select.value);
    update?.();
    syncConstructionCommands();
  };
  return select;
}

function renderScopeDrawer() {
  if (currentEditor?.mode !== 'scope') return;
  const scope = window.ribbonEnergyScopeSummary();
  content.replaceChildren();
  const subtitle = document.createElement('p');
  subtitle.className = 'construction-drawer-subtitle';
  subtitle.textContent = 'Energy settings';
  const range = document.createElement('p');
  range.className = 'construction-drawer-description';
  range.textContent = scope.kind === 'level' ? `Applies to ${scope.count} ${scope.count === 1 ? 'zone' : 'zones'} on this level.` :
    scope.kind === 'opening' ? 'Applies to this opening.' :
    scope.kind === 'zone' ? 'Applies to this zone.' : 'Sets defaults for the building.';
  const list = document.createElement('div');
  list.className = 'construction-scope-list';
  const selected = window.getEnergyBrowserSelection();
  for (const [type,label] of drawerConstructionTypes) {
    if (selected.kind === 'opening' && selected.openingKind !== type) continue;
    const spec = window.ribbonGetScopedConstruction(type);
    if (!spec || spec.readOnly) continue;
    const row = document.createElement('div');
    row.className = 'construction-scope-row';
    const field = document.createElement('label');
    field.textContent = label;
    field.append(makeAssemblySelect(type,label,spec,undefined,renderScopeDrawer));
    row.append(field,scopeMarker(spec));
    list.append(row);
  }
  if (!list.childElementCount) {
    const message = document.createElement('p');
    message.className = 'construction-drawer-description';
    message.textContent = 'No zones are available at this scope.';
    list.append(message);
  }
  content.append(subtitle,range,list);
}

function openScopeDrawer() {
  const scope = window.ribbonEnergyScopeSummary();
  beginConstructionEditor(scope.name, {mode:'scope'});
  renderScopeDrawer();
}

function drawerAction(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'construction-drawer-action';
  button.textContent = label;
  button.onclick = action;
  return button;
}

function appendConstructionDetails(card,type,symbol,spec) {
  const details = spec.effectiveId ? window.ribbonConstructionDetails(type,spec.effectiveId) : null;
  const preview = document.createElement('div');
  preview.className = 'construction-preview';
  preview.innerHTML = `<svg class="lucide-icon" aria-hidden="true"><use href="#${symbol}"/></svg>`;
  card.append(preview);
  const legacySelect = card._assemblySelect;
  const label = drawerConstructionTypes.find(entry=>entry[0] === type)[1];
  const assemblyLabel = type === 'window' && spec.scopeKind === 'opening' ? 'Window' : label;
  const chooser = document.createElement('div');
  chooser.className = 'construction-chooser';
  chooser.append(makeAssemblySelect(type,assemblyLabel,spec,legacySelect,refreshConstructionDrawer));
  const copy = drawerAction('Copy & edit',()=>window.ribbonOpenConstructionCustom(type));
  copy.disabled = !details || spec.readOnly;
  chooser.append(copy);
  card.append(chooser);
  const newCustom = drawerAction('+ New custom assembly',()=>window.ribbonOpenConstructionCustom(type,true));
  newCustom.disabled = !details || spec.readOnly;
  card.append(newCustom);
  if (spec.readOnly) {
    const note = document.createElement('p');
    note.className = 'construction-drawer-description';
    note.textContent = 'Showing the building default. Select a scope with zones to edit this assignment.';
    card.append(note);
  }

  if (details?.layers) {
    const layerTitle = document.createElement('div');
    layerTitle.className = 'construction-layer-heading';
    const order = document.createElement('small');
    order.textContent = details.order;
    layerTitle.append('Layers',order);
    const layers = document.createElement('ol');
    layers.className = 'construction-layers';
    for (const item of details.layers) {
      const row = document.createElement('li');
      const size = document.createElement('span');
      size.textContent = item.size;
      row.append(item.name,size);
      layers.append(row);
    }
    const metrics = document.createElement('div');
    metrics.className = 'en-assembly-metrics construction-details-metrics';
    metrics.innerHTML = details.metrics;
    const color = document.createElement('label');
    color.className = 'construction-display-color';
    color.textContent = 'Display colour';
    const input = document.createElement('input');
    input.type = 'color';
    input.value = details.color;
    input.disabled = spec.readOnly;
    input.onchange = () => window.ribbonSetConstructionDisplayColor(spec.effectiveId,input.value);
    color.append(input);
    card.append(layerTitle,layers,metrics,color);
  } else {
    const note = document.createElement('p');
    note.className = 'construction-drawer-description';
    note.textContent = details?.error || (spec.mixed ? 'Assignments vary by zone. Choose an assembly to apply it to the whole level.' : 'This scope uses the default construction.');
    card.append(note);
  }

  if (card._thickness && !spec.readOnly) {
    const advanced = document.createElement('details');
    advanced.className = 'construction-advanced';
    advanced.open = !!currentEditor.advanced;
    advanced.ontoggle = () => { if (currentEditor?.mode === 'construction') currentEditor.advanced = advanced.open; };
    const caption = document.createElement('summary');
    caption.textContent = 'Advanced';
    advanced.append(caption,card._thickness);
    card.append(advanced);
  }
  const opening = window.getEnergyBrowserSelection();
  if (opening.kind === 'opening' && type !== 'skylight') {
    card.append(drawerAction('Opening properties', () => window.envOpenBrowserOpeningEditor(opening)));
  }
}

function refreshConstructionDrawer() {
  if (currentEditor?.mode !== 'construction') return;
  const {type} = currentEditor;
  const spec = window.ribbonGetScopedConstruction(type);
  if (!spec) {
    const note = document.createElement('p');
    note.className = 'construction-drawer-description';
    note.textContent = 'This assembly is unavailable for the current Browser selection. Select the building or another scope.';
    content.replaceChildren(note);
    return;
  }
  const id = currentEditor.cardId;
  const styles = drawerConstructionTypes.find(entry=>entry[0] === type);
  const original = id && document.getElementById(id);
  // Keep the original thickness and assignment input IDs and restore their card
  // to its legacy location when leaving the drawer.
  if (original && !content.contains(original)) {
    for (const old of homes.keys()) {
      homes.get(old).remove();
      homes.delete(old);
    }
    const marker = document.createComment(`home:${id}`);
    original.before(marker);
    homes.set(original,marker);
    content.replaceChildren(original);
  }
  const card = original || document.createElement('div');
  const reference = homes.get(card);
  if (reference && !reference.restoreCard) {
    reference.restoreCard = card.cloneNode(true);
    card._assemblySelect = card.querySelector('select');
    card._thickness = card.querySelector('.srow');
  }
  card.replaceChildren();
  card.classList.add('construction-details');
  appendConstructionDetails(card,type,styles[2],spec);
  if (!original) content.replaceChildren(card);
  window.ribbonSetAssemblyTint(type);
}

function openConstructionDrawer(type,anchor) {
  const selected = window.getEnergyBrowserSelection();
  if (type === 'door') window.ribbonEnsureDoorAssembly();
  const label = drawerConstructionTypes.find(entry=>entry[0] === type)[1];
  const prefix = selected.kind === 'building' ? 'en' : 'zp';
  if (!['opening','building'].includes(selected.kind)) window.enSetSettingsTab('zone','constructions');
  const cardId = selected.kind !== 'opening' && type !== 'skylight' ? `ribbon-assembly-${prefix}-${type}` : null;
  beginConstructionEditor(type === 'window' && selected.kind === 'opening' ? 'Window' : label,
    {mode:'construction',type,anchor,cardId});
  refreshConstructionDrawer();
  syncConstructionCommands();
}

function syncConstructionCommands() {
  for (const command of document.querySelectorAll('[data-construction-type]')) {
    const type = command.dataset.constructionType;
    const spec = window.ribbonGetScopedConstruction(type);
    const status = command.querySelector('.construction-command-status');
    if (status && spec) {
      status.textContent = spec.mixed ? 'Mixed' : spec.localCount ? 'Override' : 'Inherited';
      command.setAttribute('aria-description',status.textContent);
    }
    const active = currentEditor?.mode === 'construction' && currentEditor.type === type;
    command.classList.toggle('active',active);
    command.setAttribute('aria-pressed',String(active));
  }
}

function constructionCommand(group,type,label,symbol) {
  const command = button(group,label,symbol,anchor=>openConstructionDrawer(type,anchor));
  command.dataset.constructionType = type;
  if (window.getEnergyBrowserSelection().kind !== 'building') {
    const status = document.createElement('small');
    status.className = 'construction-command-status';
    status.setAttribute('aria-hidden','true');
    command.append(status);
    const spec = window.ribbonGetScopedConstruction(type);
    if (spec) {
      status.textContent = spec.mixed ? 'Mixed' : spec.localCount ? 'Override' : 'Inherited';
      command.setAttribute('aria-description',status.textContent);
    }
  }
}
const maps = {
  daylight:{
    'Sensor grid':[['Draw grid','lucide-grid-2x2',()=>window.setTool('custom-grid')],['Grid settings','lucide-grid-2x2',['pb-body-dl-grid']]],
    'Surface reflectance':[['Reflectance','lucide-sun',['pb-body-dl-reflectances']]],
    'Glass and ground':[['Glass / ground','lucide-mirror-rectangular',['pb-body-dl-glazing']]],
    Climate:[['Climate','lucide-cloud-sun-rain',['pb-body-dl-climate']]],
    Display:[['Area grid','lucide-grid-2x2',()=>window.dlSetGridDisplayMode('area')],['Point grid','lucide-circle-dot',()=>window.dlSetGridDisplayMode('points')]],
  },
  solar:{
    'Result period':[['Period','lucide-sheet',['ribbon-solar-period']]],
    'Spatial grid':[['Resolution','lucide-grid-2x2',['pb-body-solar-grid']]],
    Scene:[['Scene','lucide-trees',['pb-body-solar-scene']]],
    'PV potential':[['PV potential','ribbon-solar-panel',['pb-body-solar-pv']]],
    'Display scale':[['Display scale','ribbon-tab-view',['pb-body-solar-display']]],
  },
  wind:{
    Source:[['Climate','lucide-cloud-sun-rain',()=>window.climatePromptForFile('Load an EPW climate file for weather-based wind.')]],
    Direction:[['Direction','lucide-wind-arrow-down',['pb-body-wind-direction']]],
    Flow:[['Flow','ribbon-tab-wind',['pb-body-wind-parameters']]],
    'Analysis tools':[['Domain','lucide-square-dashed',()=>window.setWindTool('wind-domain')],['Spawn line','ribbon-tab-wind',()=>window.setWindTool('wind-spawn')],['Zone','lucide-box',()=>window.setWindTool('wind-zone')]],
    Display:[['Display','ribbon-tab-view',['pb-body-wind-display']]],
  },
  view:{
    View:[['2D','ribbon-zone',()=>window.setViewMode('2d')],['3D','lucide-box',()=>window.setViewMode('3d')]],
    Camera:[['Fit model','ribbon-fit',()=>window.ribbonFitView()],['Reset camera','ribbon-camera',()=>window.ribbonResetView()]],
    'Show on the plan':[['Dimensions','ribbon-ruler',()=>window.toggleDimensions()],['Zone names','ribbon-list',()=>window.toggleViewZoneNames()],['Grid','ribbon-grid',()=>window.toggleViewGrid()],['Roof','ribbon-cmd-roof',()=>window.toggleViewRoof()],['Other levels','lucide-layers-2',()=>window.toggleShowOtherLevels()],['Archi mode','lucide-brick-wall',()=>window.toggleViewArchiMode2D()]],
    Panels:[['Browser','ribbon-building',()=>window.envProjectBrowser.toggleDrawer()],['Settings panel','ribbon-sliders',toggleSettings],['Results','ribbon-bars',toggleResults]],
  },
};
function renderGroup(group, tab, subtab, name) {
  if(tab==='energy' && subtab==='compliance'){renderComplianceGroup(group,name,{button,selectField});return;}
  const lastGroup = {energy:'Exchange',daylight:'Display',solar:'Display scale',wind:'Display',view:'Panels'};
  const energyLast={constructions:'Exchange',activity:'Schedules',hvac:'Plant',schedules:'Library'};
  if (name === (tab==='energy'?energyLast[subtab]:lastGroup[tab]) && tab !== 'view' && !(tab==='wind'&&name==='Display')) {
    editor(group,'Advanced','lucide-sheet',[`${tab}-panels`]);
  }
  const inline = {
    daylight:{'Sensor grid':[['dl-s-spacing','Spacing · cm'],['dl-s-sensor-height','Height · cm'],['dl-s-offset','Offset · cm']], 'Surface reflectance':[['dl-s-ceiling','Ceiling · %'],['dl-s-walls','Walls · %'],['dl-s-floor','Floor · %']], 'Glass and ground':[['dl-s-vt','Glazing VT · %'],['dl-s-wall-thickness','Thickness · cm'],['dl-s-ground','Ground · %']],Display:[['dl-view-mode','Metric']]},
    solar:{'Spatial grid':[['solar-resolution','Resolution'],['solar-max-cells','Maximum cells']], 'Display scale':[['solar-scale-mode','Scale']]},
    wind:{Source:[],Direction:[['s-deg','Angle · °'],['s-spd','Speed · m/s']],Flow:[['s-parts','Particles'],['s-turb','Turbulence']],Display:[['chk-show-pressure','Pressure'],['chk-show-particles','Particles'],['chk-show-vectors','Vectors'],['chk-show-zone-velocity','Velocity bands']]},
  };
  const wind=tab==='wind'?window.getRibbonWindState():null;
  if(wind && name==='Source') {
    const stack=document.createElement('div');stack.className='ribbon-live-controls';
    selectField(stack,'Wind source',[['manual','Manual'],['weather','Weather data']],wind.source,value=>{
      window.setWindSource(value);window.envRibbonUI.activateTab('wind',{callEngine:false});
    });
    if(wind.source==='weather') {
      liveControl(stack,'wind-weather-period','Period');
      if(wind.period==='season')liveControl(stack,'wind-weather-season','Season');
      if(wind.period==='day')liveControl(stack,'wind-weather-date','Day');
    }
    group.append(stack);
  }
  const fields = inline[tab]?.[name] || [];
  if(fields.length) {
    const stack=document.createElement('div');stack.className=`ribbon-live-controls${tab==='wind'&&name==='Display'?' ribbon-wind-display-controls':''}`;fields.forEach(([id,label])=>liveControl(stack,id,label));
    if(wind && name==='Flow')selectField(stack,'Quality',[['8','High'],['16','Low']],wind.quality,value=>window.setResolution(Number(value)));
    group.append(stack);
  }
  if (tab !== 'energy') {
    if(tab==='wind' && name==='Direction') {
      const pad=document.createElement('div');pad.className='ribbon-wind-pad';
      [[315,'↖'],[0,'↑'],[45,'↗'],[270,'←'],[null,'·'],[90,'→'],[225,'↙'],[180,'↓'],[135,'↘']].forEach(([angle,label])=>{
        const b=document.createElement('button');b.type='button';b.textContent=label;b.disabled=angle===null;
        b.setAttribute('aria-label',angle===null?'Wind direction':`Wind toward ${angle} degrees`);
        b.dataset.windManualControl='';b.disabled=angle===null || wind.source==='weather';
        b.classList.toggle('active',angle===wind.angle);
        b.onclick=()=>window.setDeg(angle);pad.append(b);
      });group.prepend(pad);
    }
    (maps[tab]?.[name] || []).forEach(([label,icon,action]) => {
      if (Array.isArray(action)) editor(group,label,icon,action);
      else {
        const b=button(group,label,icon,anchor=>{action(anchor); if(tab==='view' && !['Settings panel','Results'].includes(label)) window.envRibbonUI.activateTab('view',{callEngine:false});});
        if(tab==='view') { const active=window.getRibbonViewState?.()[label]; if(active!=null){b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));} }
        if(tab==='view' && label==='Settings panel'){b.classList.toggle('active',viewSettings);b.setAttribute('aria-pressed',String(viewSettings));}
        if(tab==='view' && label==='Results'){const active=resultsDrawer.expanded;b.classList.toggle('active',active);b.setAttribute('aria-pressed',String(active));}
      }
    });
    if(tab==='wind'&&name==='Display')editor(group,'Advanced','lucide-sheet',['wind-panels']);
    return;
  }
  const scope = energyScope();
  if (window.getEnergyBrowserSelection?.().kind === 'opening') {
    const selected=window.getEnergyBrowserSelection();
    const isDoor=selected.openingKind==='door';
    if (subtab === 'constructions' && (isDoor ? name === 'Doors' : name === 'Glazing')) {
      const [type,label,symbol] = drawerConstructionTypes.find(entry=>entry[0] === selected.openingKind);
      constructionCommand(group,type,type === 'window' ? 'Window' : label,symbol);
    }
    return;
  }
  if (subtab === 'constructions') {
    if (name === 'Opaque assemblies' || name === 'Glazing' || name === 'Doors') {
      const types = name === 'Doors' ? drawerConstructionTypes.slice(-1) :
        name === 'Glazing' ? drawerConstructionTypes.slice(-3,-1) : constructionTypes;
      types.forEach(([type,label,symbol])=>constructionCommand(group,type,label,symbol));
    } else if (name === 'Exchange') {
      button(group,'Export library','lucide-sheet',()=>window.enExportConstructionLibrary());
      button(group,'Load library','lucide-layers-2',()=>document.getElementById('en-library-file').click());
    } else if (name === 'Library') {
      const field=document.createElement('label');field.className='ribbon-library-select';field.textContent='Assemblies';
      const select=document.createElement('select');select.setAttribute('aria-label','Construction library');
      select.title='Filters assembly choices. The current assignment remains visible.';
      for(const [id,label] of [['all','Presets + Custom'],['presets','Presets'],['custom','Custom']])select.add(new Option(label,id));
      select.value=window.ribbonLibraryState();select.onchange=()=>window.ribbonSetLibraryFilter(select.value);field.append(select);group.append(field);
      editor(group,'Climate','lucide-cloud-sun-rain',['pb-body-en-climate']);
    }
  } else {
    const ids = scope === 'zone' ? {gains:'zp-zone-energyprops',setpoints:'zp-zone-hvac-setpoints',air:'zp-zone-hvac-airflow',schedules:'zp-zone-schedules'} : {gains:'en-defaults-energyprops',setpoints:'en-defaults-hvac-setpoints',air:'en-defaults-hvac-airflow',schedules:'en-defaults-schedules'};
    if (name === 'Gains') {
      energyField(group,'People','ribbon-people','occupancyDensity');
      energyField(group,'Lighting','lucide-lightbulb','lightingPowerDensity');
      energyField(group,'Equipment','lucide-box','equipmentPowerDensity');
    }
    if (name === 'Air' || name === 'Airflow') {
      energyField(group,'Outdoor air','ribbon-tab-wind','outdoorAirRate');
      energyField(group,'Infiltration','lucide-house','infiltrationACH');
    }
    if (name === 'Set points') {
      energyField(group,'Heating','lucide-thermometer-snowflake','setpointHeating');
      energyField(group,'Cooling','lucide-thermometer-snowflake','setpointCooling');
    }
    if (name === 'Plant') editor(group,'Site electricity','lucide-lightbulb',['en-site-energy-settings','en-fan-pump-settings']);
    if (name === 'System') { button(group,'Ideal loads','lucide-thermometer-snowflake',()=>{}); ['VAV','FCU','Split'].forEach(label=>button(group,`${label} · soon`,'ribbon-tab-wind',()=>{},true)); }
    if (name === 'Schedules') editor(group,'Schedules','lucide-sheet',[ids.schedules]);
    if (name === 'Schedule') scheduleControls(group);
    if (name === 'Hourly profile') scheduleProfile(group);
  }
}
window.envAnalysisRibbon = {
  renderGroup, subtabChanged:close, syncCompliance,
  tabChanged(tab) {
    close();
    if (['energy','daylight','solar','wind'].includes(tab)) {
      lastPhysics = tab;
      resultsDrawer.setPhysics(tab);
    }
    syncCompliance();
  },
};
window.addEventListener('env-results-drawer-change',syncViewButtons);
window.addEventListener('env-browser-drawer-change',syncViewButtons);
window.addEventListener('env-browser-scope-change', event => {
  const state = window.envRibbonUI.getState();
  if (state.activeTab === 'energy' && state.activeEnergySubtab !== 'compliance' && event.detail.openScopeDrawer !== false) openScopeDrawer();
  else close();
});
window.addEventListener('resize', () => {
  if (panel.classList.contains('construction-drawer')) positionConstructionDrawer(currentEditor?.anchor);
});
document.addEventListener('keyup',event=>{
  if(event.target.closest('input,select,textarea'))return;
  if(window.envRibbonUI.getState().activeTab==='view' && (['2','3'].includes(event.key) || (event.shiftKey && ['g','r','z','a'].includes(event.key.toLowerCase()))))window.envRibbonUI.activateTab('view',{callEngine:false});
});
const periodRow = document.getElementById('solar-period')?.closest('.srow');
if (periodRow) periodRow.id = 'ribbon-solar-period';
document.querySelector('[oninput="onParts(+this.value)"]')?.setAttribute('id','s-parts');
document.querySelector('[oninput="onTurb(+this.value)"]')?.setAttribute('id','s-turb');
new MutationObserver(refreshEditor).observe(document.getElementById('energy-panels'),{childList:true,subtree:true});
['zpSelectAssembly','zpUpdateEnergyPropField','enUpdateConstructionThickness','enSelectSchedule','enCustomizeSchedule','enUpdateScheduleName','enUpdateScheduleHour'].forEach(name => {
  const original = window[name];
  if (!original) return;
  window[name] = (...args) => {
    if (name.startsWith('en') && args[0] !== 'zone') return original(...args);
    return window.runBrowserScopedEnergyEdit(original,args);
  };
});
document.body.classList.add('analysis-ribbon-ready');
window.envRibbonUI.activateTab(window.envRibbonUI.getState().activeTab,{callEngine:false});
