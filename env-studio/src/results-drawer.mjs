import {bindDrawerHandle} from './drawer-handle.mjs';

const drawer = document.getElementById('results-drawer');
const handle = drawer.querySelector('.results-drawer-handle');
const dock = document.getElementById('settings-results-dock');
const empty = document.getElementById('ribbon-results-empty');
const panels = new Map([...dock.querySelectorAll('[data-physics-result]')]
  .map(panel => [panel.dataset.physicsResult, panel]));
const collapsed = new Set();
const sizes = new Map();
const sideModes = new Set(['daylight', 'solar', 'wind']);
let physics = 'energy';
let expanded = false;
let manuallyShown = false;

function update() {
  const hasResults = panels.get(physics)?.classList.contains('show');
  const engine = physics[0].toUpperCase() + physics.slice(1);
  drawer.hidden = !hasResults && !manuallyShown;
  drawer.dataset.physics = physics;
  drawer.dataset.edge = sideModes.has(physics) ? 'right' : 'bottom';
  drawer.dataset.expanded = String(expanded);
  const size = sizes.get(physics);
  if (size) drawer.style.setProperty('--result-size', `${size}px`);
  else drawer.style.removeProperty('--result-size');
  handle.setAttribute('aria-expanded', String(expanded));
  handle.setAttribute('aria-label', `${expanded ? 'Collapse' : 'Expand'} ${engine} results`);
  handle.firstElementChild.textContent = `${engine} results`;
  dock.inert = !expanded;
  empty.hidden = !!hasResults;
  empty.textContent = `No ${engine} results yet. Run an analysis to see them here.`;
  window.dispatchEvent(new Event('env-results-drawer-change'));
}

export const resultsDrawer = {
  get expanded() { return expanded && !drawer.hidden; },
  setPhysics(next) {
    if (!panels.has(next) || physics === next) return;
    physics = next;
    manuallyShown = false;
    expanded = panels.get(physics).classList.contains('show') && !collapsed.has(physics);
    dock.scrollTop = 0;
    update();
  },
  reveal(owner) {
    collapsed.delete(owner);
    if (owner !== physics) return;
    expanded = true;
    update();
  },
  toggle() { this.setExpanded(!this.expanded); },
  setExpanded(value) {
    expanded = value;
    manuallyShown = true;
    if (expanded) collapsed.delete(physics);
    else collapsed.add(physics);
    update();
  },
};

let startSize;
function resizeResults(delta, starting) {
  const side = sideModes.has(physics);
  if (starting) {
    startSize = expanded ? (side ? drawer.offsetWidth : dock.offsetHeight) : 0;
  }
  const limit = side ? drawer.parentElement.clientWidth * .72 : drawer.parentElement.clientHeight * .85;
  sizes.set(physics, Math.min(limit, Math.max(side ? 270 : 100, startSize + delta)));
  if (!expanded) resultsDrawer.setExpanded(true);
  else update();
}

bindDrawerHandle(handle, (dx, dy, starting) => {
  resizeResults(sideModes.has(physics) ? -dx : -dy, starting);
});
handle.addEventListener('click', () => resultsDrawer.toggle());
handle.addEventListener('keydown', event => {
  const direction = sideModes.has(physics) ? {ArrowLeft:1, ArrowRight:-1} : {ArrowUp:1, ArrowDown:-1};
  if (!(event.key in direction)) return;
  event.preventDefault();
  resizeResults(direction[event.key] * 24, true);
});
const visibilityObserver = new MutationObserver(update);
for (const panel of panels.values()) {
  visibilityObserver.observe(panel, { attributes:true, attributeFilter:['class'] });
}

const energyDashboard = document.getElementById('en-dashboard');
const energyViews = [...drawer.querySelectorAll('[data-energy-result-view]')];
const energySections = {
  '.energy-result-summary':['end-uses'],
  '.energy-result-end-uses':['end-uses'],
  '.energy-result-monthly':['end-uses','monthly'],
  '.energy-balance-chart':['end-uses','monthly'],
  '#en-energy-pv-card':['end-uses'],
  '.energy-result-zones':['zones'],
  '.energy-result-compare':['compare'],
};
for (const button of energyViews) {
  button.addEventListener('click', () => {
    const view = button.dataset.energyResultView;
    energyDashboard.dataset.view = view;
    for (const [selector, views] of Object.entries(energySections)) {
      energyDashboard.querySelector(selector).hidden = !views.includes(view);
    }
    for (const item of energyViews) item.setAttribute('aria-pressed', String(item === button));
    dock.scrollTop = 0;
  });
}

document.getElementById('en-zone-table').addEventListener('click', event => {
  const row = event.target.closest('[data-result-zone]');
  if (row) window.selectEnergyResultZone(row.dataset.resultZone);
});
window.addEventListener('env-browser-scope-change', () => window.syncEnergyResultZoneHighlight());

new ResizeObserver(() => {
  const side = sideModes.has(physics);
  drawer.parentElement.style.setProperty('--results-drawer-height', `${side ? 0 : drawer.offsetHeight}px`);
  drawer.parentElement.style.setProperty('--results-drawer-width', `${side ? drawer.offsetWidth : 0}px`);
}).observe(drawer);

window.envResultsDrawer = resultsDrawer;
update();
