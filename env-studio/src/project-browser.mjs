import {bindDrawerHandle} from './drawer-handle.mjs';

const host = document.getElementById('project-browser-tree');
const search = document.getElementById('project-browser-search');
const northInput = document.getElementById('browser-true-north');
const browserDrawer = document.getElementById('project-browser');
const drawerHandle = browserDrawer.querySelector('.project-browser-handle');
let resizeFrame = 0;

function resizeWorkspace() {
  if (resizeFrame) return;
  resizeFrame = requestAnimationFrame(() => {
    resizeFrame = 0;
    window.dispatchEvent(new Event('resize'));
  });
}

function setBrowserCollapsed(collapsed) {
  browserDrawer.dataset.collapsed = String(collapsed);
  drawerHandle.setAttribute('aria-expanded', String(!collapsed));
  drawerHandle.setAttribute('aria-label', collapsed ? 'Expand Browser' : 'Collapse Browser');
  window.dispatchEvent(new Event('env-browser-drawer-change'));
  resizeWorkspace();
}

function toggleDrawer() {
  setBrowserCollapsed(browserDrawer.dataset.collapsed !== 'true');
}

let startWidth;
function resizeBrowser(delta, starting) {
  if (starting) {
    startWidth = browserDrawer.dataset.collapsed === 'true' ? 0 : browserDrawer.offsetWidth;
  }
  const width = Math.max(154, Math.min(520, startWidth + delta));
  browserDrawer.style.setProperty('--browser-width', `${width}px`);
  if (browserDrawer.dataset.collapsed === 'true') setBrowserCollapsed(false);
  else resizeWorkspace();
}

bindDrawerHandle(drawerHandle, (dx, _dy, starting) => resizeBrowser(dx, starting));
drawerHandle.addEventListener('click', toggleDrawer);
drawerHandle.addEventListener('keydown', event => {
  if (!['ArrowLeft','ArrowRight'].includes(event.key)) return;
  event.preventDefault();
  resizeBrowser(event.key === 'ArrowRight' ? 24 : -24, true);
});

const expanded = new Set(['building']);
let query = '';
let snapshot = null;

const ICONS = {
  building:'lucide-house',
  level:'lucide-layers-2',
  zone:'lucide-box',
  window:'lucide-mirror-rectangular',
  door:'lucide-door-open',
  skylight:'lucide-grid-2x2',
};

function svg(symbol, className = '') {
  const element = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  element.setAttribute('class', `lucide-icon ${className}`.trim());
  element.setAttribute('aria-hidden', 'true');
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
  use.setAttribute('href', `#${symbol}`);
  element.append(use);
  return element;
}

function normalized(value) { return String(value || '').trim().toLowerCase(); }

function selectionKey(selection) {
  if (!selection) return 'building';
  if (selection.kind === 'building') return 'building';
  if (selection.kind === 'level') return `level:${selection.levelIdx}`;
  if (selection.kind === 'zone') return `zone:${selection.zoneId}`;
  return selection.id;
}

function treeMatches(level) {
  if (!query) return true;
  const needle = normalized(query);
  return normalized(snapshot?.building?.label).includes(needle) ||
    normalized(level.label).includes(needle) ||
    level.zones.some(zone => normalized(zone.label).includes(needle) ||
      zone.openings.some(opening => normalized(opening.label).includes(needle) || normalized(opening.kind).includes(needle)));
}

function zoneMatches(zone) {
  if (!query) return true;
  const needle = normalized(query);
  return normalized(snapshot?.building?.label).includes(needle) || normalized(zone.label).includes(needle) ||
    zone.openings.some(opening => normalized(opening.label).includes(needle) || normalized(opening.kind).includes(needle));
}

function openingMatches(opening) {
  if (!query) return true;
  const needle = normalized(query);
  return normalized(opening.label).includes(needle) || normalized(opening.kind).includes(needle);
}

function makeRow({ key, kind, label, meta = '', depth, local, hasChildren, selection, onSelect }) {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'browser-tree-row';
  row.style.setProperty('--browser-depth', depth);
  row.dataset.browserKey = key;
  row.setAttribute('role', 'treeitem');
  row.setAttribute('aria-level', String(depth + 1));
  row.classList.toggle('selected', selectionKey(selection) === key);
  row.setAttribute('aria-selected', String(selectionKey(selection) === key));
  if (hasChildren) row.setAttribute('aria-expanded', String(query ? true : expanded.has(key)));

  const chevron = document.createElement('span');
  chevron.className = `browser-tree-chevron${hasChildren && (query || expanded.has(key)) ? ' open' : ''}${hasChildren ? '' : ' blank'}`;
  chevron.append(svg('lucide-chevron-right'));

  const kindIcon = svg(ICONS[kind] || 'lucide-box', 'browser-tree-kind');
  const copy = document.createElement('span');
  copy.className = 'browser-tree-label';
  copy.append(document.createTextNode(label));
  if (meta) {
    const detail = document.createElement('small');
    detail.textContent = meta;
    copy.append(detail);
  }
  const dot = document.createElement('i');
  dot.className = `browser-scope-dot${local ? ' local' : ''}`;
  dot.title = local ? 'Energy settings assigned here' : 'Inherits energy settings from parent';
  row.append(chevron, kindIcon, copy, dot);
  row.addEventListener('click', event => {
    if (hasChildren && event.target.closest('.browser-tree-chevron')) {
      if (expanded.has(key)) expanded.delete(key); else expanded.add(key);
      render();
      return;
    }
    onSelect();
    if (hasChildren) expanded.add(key);
    refresh();
  });
  return row;
}

function render() {
  if (!host || !snapshot) return;
  const fragment = document.createDocumentFragment();
  const selection = snapshot.selection;
  const visibleLevels = snapshot.levels.filter(treeMatches);
  const buildingOpen = query || expanded.has('building');

  fragment.append(makeRow({
    key:'building', kind:'building', label:snapshot.building.label, depth:0,
    local:snapshot.building.local, hasChildren:true, selection,
    onSelect:() => window.selectEnergyBrowserNode?.({ kind:'building', id:'building' }),
  }));

  if (buildingOpen) visibleLevels.forEach(level => {
    const levelKey = `level:${level.index}`;
    const levelOpen = query || expanded.has(levelKey);
    const visibleZones = level.zones.filter(zoneMatches);
    fragment.append(makeRow({
      key:levelKey, kind:'level', label:level.label,
      meta:`+${Number(level.elevation || 0).toFixed(1)} m`, depth:1,
      local:level.local, hasChildren:visibleZones.length > 0, selection,
      onSelect:() => window.selectEnergyBrowserNode?.({ kind:'level', id:levelKey, levelIdx:level.index }),
    }));

    if (levelOpen) visibleZones.forEach(zone => {
      const zoneKey = `zone:${zone.id}`;
      const zoneOpen = query || expanded.has(zoneKey);
      const visibleOpenings = zone.openings.filter(openingMatches);
      fragment.append(makeRow({
        key:zoneKey, kind:'zone', label:zone.label,
        meta:Number.isFinite(zone.area) ? `${zone.area.toFixed(1)} m²` : '', depth:2,
        local:zone.local, hasChildren:visibleOpenings.length > 0, selection,
        onSelect:() => window.selectEnergyBrowserNode?.({
          kind:'zone', id:zoneKey, zoneId:zone.id, btmId:zone.btmId, levelIdx:zone.levelIdx,
        }),
      }));

      if (zoneOpen) visibleOpenings.forEach(opening => {
        fragment.append(makeRow({
          key:opening.id, kind:opening.kind, label:opening.label, depth:3,
          local:opening.local, hasChildren:false, selection,
          onSelect:() => window.selectEnergyBrowserNode?.({
            kind:'opening', id:opening.id, zoneId:zone.id, levelIdx:zone.levelIdx,
          }),
        }));
      });
    });
  });

  host.replaceChildren(fragment);
  if (!host.childElementCount) {
    const empty = document.createElement('div');
    empty.className = 'project-browser-empty';
    empty.textContent = 'No matching building items.';
    host.append(empty);
  }
}

function refresh() {
  snapshot = window.getProjectBrowserSnapshot?.() || null;
  if (!snapshot) return;
  if (snapshot.selection?.levelIdx != null) expanded.add(`level:${snapshot.selection.levelIdx}`);
  if (snapshot.selection?.zoneId) expanded.add(`zone:${snapshot.selection.zoneId}`);
  if (northInput && document.activeElement !== northInput) northInput.value = snapshot.trueNorth;
  render();
}

search?.addEventListener('input', () => {
  query = search.value;
  render();
});

document.getElementById('browser-add-level')?.addEventListener('click', () => {
  window.addLevelQuick?.();
  refresh();
});
document.getElementById('browser-edit-levels')?.addEventListener('click', () => window.openLevelsModal?.());
document.getElementById('browser-rebuild-zones')?.addEventListener('click', () => {
  window.recompileBTM?.();
  refresh();
});
northInput?.addEventListener('change', () => window.setTrueNorth?.(northInput.value));
northInput?.addEventListener('keydown', event => {
  if (event.key === 'Enter') { window.setTrueNorth?.(northInput.value); northInput.blur(); }
});
window.addEventListener('env-browser-scope-change', refresh);

window.envProjectBrowser = {
  refresh,
  toggleDrawer,
  getSelection:() => window.getEnergyBrowserSelection?.(),
  revealNode(target, {focus = true, openScopeDrawer = true} = {}) {
    if (browserDrawer.dataset.collapsed === 'true') setBrowserCollapsed(false);
    query = '';
    search.value = '';
    const selection = window.selectEnergyBrowserNode(target,{openScopeDrawer});
    refresh();
    const key = selectionKey(selection);
    const row = [...host.querySelectorAll('[data-browser-key]')].find(item=>item.dataset.browserKey === key);
    row?.scrollIntoView({block:'nearest'});
    if (focus) row?.focus({preventScroll:true});
  },
  selectZone(zoneId) {
    const zone = snapshot?.levels.flatMap(level => level.zones).find(item => item.id === zoneId || item.btmId === zoneId);
    if (!zone) return false;
    window.selectEnergyBrowserNode?.({ kind:'zone', id:`zone:${zone.id}`, zoneId:zone.id, btmId:zone.btmId, levelIdx:zone.levelIdx });
    refresh();
    return true;
  },
};

refresh();
