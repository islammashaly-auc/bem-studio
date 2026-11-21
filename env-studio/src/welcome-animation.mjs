import { gsap } from 'gsap';

const overlay = document.getElementById('welcome-overlay');
const shell = overlay?.querySelector('.w-shell');
const lensStage = document.getElementById('w-lens-stage');
const canvas = document.getElementById('w-particle-canvas');
const context = canvas?.getContext('2d', { alpha:true });
const reduceMotionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');

const MODE_ORDER = ['energy', 'daylight', 'wind', 'solar'];
const MODES = {
  energy:{ label:'Energy', color:'#3de8b0', rgb:[61, 232, 176] },
  daylight:{ label:'Daylight', color:'#f0a832', rgb:[240, 168, 50] },
  wind:{ label:'Wind', color:'#4a9ef0', rgb:[74, 158, 240] },
  solar:{ label:'Solar', color:'#ffd34e', rgb:[255, 211, 78] },
};
const SOLAR_PANEL_PATHS = [
  'M11 2h2',
  'm14.28 14-4.56 8',
  'm21 22-1.558-4H4.558',
  'M3 10v2',
  'M6.245 15.04A2 2 0 0 1 8 14h12a1 1 0 0 1 .864 1.505l-3.11 5.457A2 2 0 0 1 16 22H4a1 1 0 0 1-.863-1.506z',
  'M7 2a4 4 0 0 1-4 4',
  'm8.66 7.66 1.41 1.41',
];
const CYCLE_SECONDS = 5;
const PARTICLE_PULSE_LEG_SECONDS = 1;
const PARTICLE_ENTRANCE_DELAY_SECONDS = 1;
const PARTICLE_ENTRANCE_DURATION_SECONDS = 1;
const INACTIVE_MODE_OPACITY = .48;
const SVG_NS = 'http://www.w3.org/2000/svg';
// The particle field occupies 73% of the 440-unit lens. This ratio maps its
// canvas radius precisely to the innermost SVG circle at r=126.
const GRID_RADIUS_RATIO = 126 / (440 * .73);

let entrance = null;
let exit = null;
let cycle = null;
let pulse = null;
let morph = null;
let colorTween = null;
let signalTimeline = null;
let ringTweens = [];
let resizeObserver = null;
let currentMode = 'energy';
let dismissing = false;
let canvasSide = 0;
let particles = [];
let particleGridSize = 0;
let tickerAttached = false;
let hoveredMode = null;

const pointer = { x:0, y:0, active:false };
// Numeric channels are tweened explicitly. GSAP otherwise treats `color` on a
// plain canvas state object inconsistently across builds, which could leave the
// particle grid on the initial Energy green while the SVG lens changed mode.
const particleState = {
  morph:1, pulse:0, entryProgress:0,
  red:MODES.energy.rgb[0], green:MODES.energy.rgb[1], blue:MODES.energy.rgb[2],
};
const all = selector => overlay ? [...overlay.querySelectorAll(selector)] : [];
const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const mix = (from, to, progress) => from + (to - from) * progress;

function buildLensTicks() {
  const group = document.getElementById('w-lens-ticks');
  if (!group || group.childElementCount) return;
  const fragment = document.createDocumentFragment();
  for (let index = 0; index < 120; index++) {
    const angle = (index / 120) * Math.PI * 2 - Math.PI / 2;
    const major = index % 10 === 0;
    const medium = index % 5 === 0;
    const innerRadius = major ? 183 : medium ? 187 : 191;
    const outerRadius = major ? 203 : 200;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', String(220 + Math.cos(angle) * innerRadius));
    line.setAttribute('y1', String(220 + Math.sin(angle) * innerRadius));
    line.setAttribute('x2', String(220 + Math.cos(angle) * outerRadius));
    line.setAttribute('y2', String(220 + Math.sin(angle) * outerRadius));
    fragment.appendChild(line);
  }
  group.appendChild(fragment);
}

function drawModeMask(maskContext, mode, side) {
  const center = side / 2;
  // The expanded field restores the original on-lens icon footprint at this
  // scale while supplying more grid samples for the glyph's fine detail.
  const iconScale = side / 60;
  maskContext.clearRect(0, 0, side, side);
  maskContext.save();
  maskContext.translate(center, center);
  maskContext.scale(iconScale, iconScale);
  maskContext.translate(-12, -12);
  maskContext.fillStyle = '#fff';
  maskContext.strokeStyle = '#fff';
  maskContext.lineWidth = 2;
  maskContext.lineCap = 'round';
  maskContext.lineJoin = 'round';

  if (mode === 'energy') {
    maskContext.fill(new Path2D('M13.2 1.8 3.8 13.4a1 1 0 0 0 .78 1.63h6.05l-1.1 6.02a1 1 0 0 0 1.75.82l9.03-11.28A1 1 0 0 0 19.53 9h-5.86l1.28-6.38a1 1 0 0 0-1.75-.82Z'));
  } else if (mode === 'daylight') {
    maskContext.beginPath();
    maskContext.arc(12, 12, 4, 0, Math.PI * 2);
    maskContext.stroke();
    maskContext.stroke(new Path2D('M12 2v2M12 20v2M4.93 4.93l1.42 1.42M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.42-1.42M17.66 6.34l1.41-1.41'));
  } else if (mode === 'solar') {
    SOLAR_PANEL_PATHS.forEach(path => maskContext.stroke(new Path2D(path)));
  } else {
    maskContext.stroke(new Path2D('M3 8h10.5a2.5 2.5 0 1 0-2.45-3M3 12h15.5a2.5 2.5 0 1 1-2.45 3M3 16h7'));
  }
  maskContext.restore();
}

function backgroundParticleStyle(distance) {
  const edgeDistance = canvasSide * GRID_RADIUS_RATIO;
  const radialStrength = Math.pow(clamp(1 - distance / edgeDistance, 0, 1), .7);
  return {
    radius:canvasSide * (.0024 + .0071 * radialStrength),
    opacity:.08 + .67 * radialStrength,
  };
}

function modeTargets(mode) {
  if (!canvasSide || !particles.length) return [];
  const maskCanvas = document.createElement('canvas');
  const maskSize = Math.max(1, Math.round(canvasSide));
  maskCanvas.width = maskSize;
  maskCanvas.height = maskSize;
  const maskContext = maskCanvas.getContext('2d', { willReadFrequently:true });
  drawModeMask(maskContext, mode, maskSize);
  const pixels = maskContext.getImageData(0, 0, maskSize, maskSize).data;
  const center = canvasSide / 2;

  return particles.map(particle => {
    const sampleX = clamp(Math.round(particle.baseX), 0, maskSize - 1);
    const sampleY = clamp(Math.round(particle.baseY), 0, maskSize - 1);
    const alpha = pixels[(sampleY * maskSize + sampleX) * 4 + 3] / 255;
    const distance = Math.hypot(particle.baseX - center, particle.baseY - center);
    const backgroundStyle = backgroundParticleStyle(distance);
    const icon = alpha > .12 ? clamp(alpha * 1.15, 0, 1) : 0;
    return {
      radius:icon ? canvasSide * .01025 : backgroundStyle.radius,
      opacity:icon ? 1 : backgroundStyle.opacity,
      icon,
    };
  });
}

function rebuildParticles() {
  if (!canvasSide) return;
  // Extend the existing spacing with three new rows/columns on every side so
  // the grid reaches the first inner circle without stretching its dots.
  const count = canvasSide < 230 ? 25 : 27;
  particleGridSize = count;
  const padding = canvasSide * (.5 - GRID_RADIUS_RATIO);
  const span = canvasSide - padding * 2;
  const step = span / (count - 1);
  const center = canvasSide / 2;
  const previous = particles;
  particles = [];

  for (let row = 0; row < count; row++) {
    for (let column = 0; column < count; column++) {
      const baseX = padding + column * step;
      const baseY = padding + row * step;
      const distanceFromCenter = Math.hypot(baseX - center, baseY - center);
      if (distanceFromCenter > canvasSide * GRID_RADIUS_RATIO) continue;
      const old = previous[particles.length];
      // Every grid point begins on the circumference along its own radial
      // direction. The centre point uses a stable upward origin.
      const entryAngle = distanceFromCenter > .001
        ? Math.atan2(baseY - center, baseX - center)
        : -Math.PI / 2;
      const entryRadius = canvasSide * (GRID_RADIUS_RATIO - .004);
      particles.push({
        baseX, baseY,
        entryX:center + Math.cos(entryAngle) * entryRadius,
        entryY:center + Math.sin(entryAngle) * entryRadius,
        x:old?.x ?? baseX, y:old?.y ?? baseY,
        vx:0, vy:0,
        fromRadius:old?.targetRadius ?? 1, targetRadius:1,
        fromOpacity:old?.targetOpacity ?? .2, targetOpacity:.2,
        fromIcon:old?.targetIcon ?? 0, targetIcon:0,
      });
    }
  }
}

function resizeParticleCanvas() {
  if (!canvas || !context) return;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return;
  const nextSide = Math.min(rect.width, rect.height);
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, Math.round(rect.width * pixelRatio));
  canvas.height = Math.max(1, Math.round(rect.height * pixelRatio));
  context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
  canvasSide = nextSide;
  rebuildParticles();
  setParticleTargets(currentMode, true);
  renderParticles();
  requestAnimationFrame(updateLensWires);
}

function updateLensWires() {
  const svg = overlay?.querySelector('.w-lens-svg');
  if (!svg) return;
  const svgRect = svg.getBoundingClientRect();
  if (!svgRect.width || !svgRect.height) return;
  const toSvgX = clientX => (clientX - svgRect.left) * 440 / svgRect.width;
  const toSvgY = clientY => (clientY - svgRect.top) * 440 / svgRect.height;
  const angles = {
    energy:-Math.PI * .75,
    daylight:-Math.PI * .25,
    wind:Math.PI * .25,
    solar:Math.PI * .75,
  };

  all('[data-lens-wire]').forEach(wire => {
    const mode = wire.dataset.lensWire;
    const label = overlay.querySelector(`[data-lens-select="${mode}"]`);
    if (!label) return;
    const leftSide = mode === 'energy' || mode === 'solar';
    const labelRect = label.getBoundingClientRect();
    const targetX = toSvgX(leftSide ? labelRect.right - 3 : labelRect.left + 3);
    const targetY = toSvgY(labelRect.top + labelRect.height / 2);
    const angle = angles[mode];
    const startX = 220 + Math.cos(angle) * 160;
    const startY = 220 + Math.sin(angle) * 160;
    const topSide = mode === 'energy' || mode === 'daylight';
    const xDirection = leftSide ? -1 : 1;
    const yDirection = topSide ? -1 : 1;
    // Continue radially from the quarter midpoint: equal x/y travel makes
    // this first signal segment exactly 45 degrees in every mode.
    const diagonalRun = Math.abs(targetY - startY);
    const elbowX = startX + xDirection * diagonalRun;
    const elbowY = startY + yDirection * diagonalRun;
    wire.setAttribute('d', `M${startX.toFixed(2)} ${startY.toFixed(2)}L${elbowX.toFixed(2)} ${elbowY.toFixed(2)}L${targetX.toFixed(2)} ${targetY.toFixed(2)}`);
  });
}

function particleValue(particle, fromKey, targetKey) {
  return mix(particle[fromKey], particle[targetKey], particleState.morph);
}

function prepareParticleEntrance() {
  particleState.entryProgress = 0;
  particles.forEach(particle => {
    particle.x = particle.baseX;
    particle.y = particle.baseY;
    particle.vx = 0;
    particle.vy = 0;
  });
  renderParticles();
}

function renderParticles() {
  if (!context || !canvasSide) return;
  context.clearRect(0, 0, canvasSide, canvasSide);
  const activeColor = `rgb(${Math.round(particleState.red)},${Math.round(particleState.green)},${Math.round(particleState.blue)})`;

  const entryProgress = clamp(particleState.entryProgress, 0, 1);
  for (const particle of particles) {
    if (entryProgress >= 1) {
      const dxHome = particle.baseX - particle.x;
      const dyHome = particle.baseY - particle.y;
      particle.vx += dxHome * .045;
      particle.vy += dyHome * .045;

      if (pointer.active && !reduceMotionQuery.matches) {
        const dx = particle.x - pointer.x;
        const dy = particle.y - pointer.y;
        const distance = Math.hypot(dx, dy) || 1;
        const influence = clamp(1 - distance / (canvasSide * .28), 0, 1);
        if (influence > 0) {
          const force = influence * influence * 1.45;
          particle.vx += dx / distance * force;
          particle.vy += dy / distance * force;
        }
      }

      particle.vx *= .82;
      particle.vy *= .82;
      particle.x += particle.vx;
      particle.y += particle.vy;
    }

    const icon = particleValue(particle, 'fromIcon', 'targetIcon');
    const entryScale = mix(.16, 1, entryProgress);
    const radius = particleValue(particle, 'fromRadius', 'targetRadius') *
      (1 + particleState.pulse * .18 * icon) * entryScale;
    particle.renderIcon = icon;
    particle.renderRadius = radius;
    particle.renderOpacity = particleValue(particle, 'fromOpacity', 'targetOpacity') * entryProgress;
    particle.renderEntryOpacity = entryProgress;
    particle.renderX = mix(particle.entryX, particle.x, entryProgress);
    particle.renderY = mix(particle.entryY, particle.y, entryProgress);
  }

  // Keep the field circular even while pointer repulsion displaces particles.
  // The SVG inner ring is layered above this clipped edge for a clean bezel.
  context.save();
  context.beginPath();
  context.arc(canvasSide / 2, canvasSide / 2, canvasSide * GRID_RADIUS_RATIO, 0, Math.PI * 2);
  context.clip();

  // The selected icon gets an additive emission pass before its crisp core.
  // This gives the small canvas dots the same apparent intensity as the thick
  // active SVG quarter without washing out the lower-opacity analysis grid.
  context.save();
  context.globalCompositeOperation = 'lighter';
  context.fillStyle = activeColor;
  context.shadowColor = activeColor;
  // A tight halo keeps the active dots as luminous as the quarter ring while
  // preserving the smaller simulation icon's silhouette between grid points.
  context.shadowBlur = Math.max(4, canvasSide * .018);
  for (const particle of particles) {
    if (particle.renderIcon < .12) continue;
    context.globalAlpha = (.42 + particle.renderIcon * .4) * particle.renderEntryOpacity;
    context.beginPath();
    context.arc(particle.renderX, particle.renderY, Math.max(.6, particle.renderRadius * 1.08), 0, Math.PI * 2);
    context.fill();
  }
  context.restore();

  context.fillStyle = activeColor;
  for (const particle of particles) {
    context.globalAlpha = particle.renderIcon > .12 ? particle.renderEntryOpacity : particle.renderOpacity;
    context.beginPath();
    context.arc(particle.renderX, particle.renderY, Math.max(.45, particle.renderRadius), 0, Math.PI * 2);
    context.fill();
  }
  context.globalAlpha = 1;
  context.restore();
}

function attachTicker() {
  if (tickerAttached || reduceMotionQuery.matches) return;
  gsap.ticker.add(renderParticles);
  tickerAttached = true;
}

function detachTicker() {
  if (!tickerAttached) return;
  gsap.ticker.remove(renderParticles);
  tickerAttached = false;
}

function setParticleTargets(mode, immediate = false) {
  const targets = modeTargets(mode);
  if (!targets.length) return;
  morph?.kill();
  targets.forEach((target, index) => {
    const particle = particles[index];
    const progress = particleState.morph;
    particle.fromRadius = mix(particle.fromRadius, particle.targetRadius, progress);
    particle.fromOpacity = mix(particle.fromOpacity, particle.targetOpacity, progress);
    particle.fromIcon = mix(particle.fromIcon, particle.targetIcon, progress);
    particle.targetRadius = target.radius;
    particle.targetOpacity = target.opacity;
    particle.targetIcon = target.icon;
  });
  particleState.morph = immediate ? 1 : 0;
  if (immediate || reduceMotionQuery.matches) {
    renderParticles();
    return;
  }
  morph = gsap.to(particleState, {
    morph:1, duration:.86, ease:'power3.inOut', overwrite:'auto',
    onComplete:() => { morph = null; },
  });
}

function applyMode(mode, { immediate = false } = {}) {
  if (!MODES[mode] || !lensStage) return;
  const details = MODES[mode];
  currentMode = mode;
  lensStage.dataset.mode = mode;
  overlay.dataset.lensMode = mode;
  document.getElementById('w-lens-status-value').textContent = details.label;

  const arcs = all('[data-lens-arc]');
  const labels = all('[data-lens-select]');
  const wires = all('[data-lens-wire]');
  const activeLabel = labels.find(label => label.dataset.lensSelect === mode);
  const activeWire = wires.find(wire => wire.dataset.lensWire === mode);
  arcs.forEach(arc => arc.classList.toggle('is-active', arc.dataset.lensArc === mode));
  labels.forEach(label => label.setAttribute('aria-pressed', String(label.dataset.lensSelect === mode)));
  wires.forEach(wire => wire.classList.toggle('is-active', wire.dataset.lensWire === mode));
  updateLensWires();

  colorTween?.kill();
  signalTimeline?.kill();
  signalTimeline = null;
  if (immediate || reduceMotionQuery.matches) {
    gsap.set(lensStage, { '--lens-color':details.color });
    gsap.set(arcs, { opacity:index => arcs[index].dataset.lensArc === mode ? 1 : INACTIVE_MODE_OPACITY });
    gsap.set(labels, {
      opacity:index => labels[index].dataset.lensSelect === mode ? 1 : .48,
      scale:index => labels[index].dataset.lensSelect === mode ? 1.05 : 1,
    });
    gsap.set(wires, {
      opacity:index => wires[index].dataset.lensWire === mode ? 1 : 0,
      strokeDasharray:index => wires[index].dataset.lensWire === mode ? '1 1' : '0 1',
      strokeDashoffset:0,
    });
    [particleState.red, particleState.green, particleState.blue] = details.rgb;
  } else {
    colorTween = gsap.to(particleState, {
      red:details.rgb[0], green:details.rgb[1], blue:details.rgb[2],
      duration:.72, ease:'power2.inOut', overwrite:'auto',
      onComplete:() => { colorTween = null; },
    });
    gsap.to(lensStage, { '--lens-color':details.color, duration:.72, ease:'power2.inOut', overwrite:'auto' });
    gsap.to(arcs, {
      opacity:index => arcs[index].dataset.lensArc === mode ? 1 : INACTIVE_MODE_OPACITY,
      duration:.72, ease:'power3.inOut', overwrite:'auto',
    });
    gsap.to(labels.filter(label => label !== activeLabel), {
      opacity:.48, scale:1, duration:.32, ease:'power2.out', overwrite:'auto',
    });
    gsap.set(wires.filter(wire => wire !== activeWire), { opacity:0, strokeDasharray:'0 1', strokeDashoffset:0 });
    signalTimeline = gsap.timeline({
      onComplete:() => { signalTimeline = null; },
    });
    signalTimeline
      .fromTo(activeWire,
        { opacity:1, strokeDasharray:'0 1', strokeDashoffset:0 },
        { opacity:1, strokeDasharray:'1 1', duration:.58, ease:'power2.inOut' }, 0)
      .fromTo(activeLabel,
        { opacity:.58, scale:1 },
        { opacity:1, scale:1.05, duration:.38, ease:'back.out(1.8)' }, .25);
  }
  setParticleTargets(mode, immediate);
}

function startModeCycle(startMode = currentMode) {
  cycle?.kill();
  cycle = null;
  if (reduceMotionQuery.matches) return;
  const startIndex = MODE_ORDER.indexOf(startMode);
  const orderedModes = MODE_ORDER.map((_, offset) => MODE_ORDER[(startIndex + offset) % MODE_ORDER.length]);
  cycle = gsap.timeline({ repeat:-1 });
  orderedModes.forEach((mode, index) => {
    cycle.call(() => applyMode(mode), null, index * CYCLE_SECONDS);
  });
  cycle.to({}, { duration:CYCLE_SECONDS }, (orderedModes.length - 1) * CYCLE_SECONDS);
}

function ambientCount() {
  return [cycle, pulse, ...ringTweens].filter(Boolean).length;
}

function stopAmbientMotion() {
  cycle?.kill();
  pulse?.kill();
  morph?.kill();
  colorTween?.kill();
  signalTimeline?.kill();
  ringTweens.forEach(tween => tween?.kill());
  cycle = null;
  pulse = null;
  morph = null;
  colorTween = null;
  signalTimeline = null;
  ringTweens = [];
  particleState.pulse = 0;
  detachTicker();
}

function stopAll() {
  entrance?.kill();
  exit?.kill();
  entrance = null;
  exit = null;
  hoveredMode = null;
  stopAmbientMotion();
}

function startAmbientMotion() {
  if (!overlay || reduceMotionQuery.matches || overlay.classList.contains('hidden')) return;
  stopAmbientMotion();
  attachTicker();
  startModeCycle(currentMode);
  pulse = gsap.to(particleState, {
    pulse:1, duration:PARTICLE_PULSE_LEG_SECONDS, repeat:-1, yoyo:true, ease:'sine.inOut',
  });
  ringTweens = [
    gsap.to(all('.w-lens-ticks'), { rotation:360, svgOrigin:'220 220', duration:52, repeat:-1, ease:'none' }),
    gsap.to(all('.w-lens-rotor'), { rotation:-360, svgOrigin:'220 220', duration:68, repeat:-1, ease:'none' }),
  ];
  overlay.dataset.animationState = 'ambient';
}

function showReducedMotionState() {
  stopAll();
  overlay?.classList.remove('is-exiting');
  if (!overlay) return;
  overlay.style.removeProperty('opacity');
  gsap.set(all('.w-shell,.w-visual,.wcard,.w-lens-label,.w-brand-segment,.w-form-step'), {
    opacity:1, x:0, y:0, scale:1, rotation:0, visibility:'inherit',
  });
  gsap.set(all('.w-lens-arc'), { opacity:index => all('.w-lens-arc')[index].dataset.lensArc === currentMode ? 1 : INACTIVE_MODE_OPACITY, visibility:'inherit' });
  gsap.set(all('.w-lens-ticks,.w-lens-rotor'), { rotation:0, svgOrigin:'220 220' });
  particleState.entryProgress = 1;
  applyMode(currentMode, { immediate:true });
  renderParticles();
  overlay.dataset.animationState = 'reduced';
}

function playWelcomeAnimation() {
  if (!overlay) return;
  dismissing = false;
  stopAll();
  overlay.classList.remove('hidden', 'is-exiting');
  overlay.style.removeProperty('opacity');
  applyMode('energy', { immediate:true });
  resizeParticleCanvas();

  if (reduceMotionQuery.matches) {
    showReducedMotionState();
    return;
  }

  prepareParticleEntrance();

  overlay.dataset.animationState = 'entering';
  const tickLines = all('.w-lens-ticks line');
  entrance = gsap.timeline({
    defaults:{ ease:'power3.out' },
    onComplete:() => {
      entrance = null;
      gsap.set(overlay, { clearProps:'opacity,visibility' });
      startAmbientMotion();
    },
  });
  entrance
    .fromTo(overlay, { autoAlpha:0 }, { autoAlpha:1, duration:.28 }, 0)
    .fromTo(shell, { autoAlpha:0, y:24, scale:.985 }, { autoAlpha:1, y:0, scale:1, duration:.7 }, .05)
    .fromTo('.w-visual', { autoAlpha:0, scale:.78, rotation:-7 }, { autoAlpha:1, scale:1, rotation:0, duration:1.05, ease:'expo.out' }, .1)
    .fromTo(tickLines, { autoAlpha:0, scaleY:.15 }, {
      autoAlpha:1, scaleY:1, duration:.42, stagger:{ amount:.55, from:'center' }, ease:'power2.out',
    }, .22)
    .fromTo('.w-lens-arc', { autoAlpha:0 }, {
      autoAlpha:index => all('.w-lens-arc')[index].dataset.lensArc === currentMode ? 1 : INACTIVE_MODE_OPACITY,
      duration:.72, stagger:.07,
    }, .25)
    .fromTo('.w-lens-wire.is-active',
      { autoAlpha:1, strokeDasharray:'0 1', strokeDashoffset:0 },
      { autoAlpha:1, strokeDasharray:'1 1', duration:.58, ease:'power2.inOut' }, .48)
    .fromTo('.w-lens-label', { autoAlpha:0, scale:.82 }, {
      autoAlpha:index => all('.w-lens-label')[index].dataset.lensSelect === currentMode ? 1 : .48,
      scale:index => all('.w-lens-label')[index].dataset.lensSelect === currentMode ? 1.05 : 1,
      duration:.5, stagger:.08, ease:'back.out(1.7)',
    }, .48)
    .fromTo('.wcard', { autoAlpha:0, y:16 }, { autoAlpha:1, y:0, duration:.68 }, .42)
    .fromTo('.w-brand-segment', { autoAlpha:0, y:16 }, {
      autoAlpha:1, y:0, duration:.55, stagger:.07,
    }, .5)
    .fromTo('.w-form-step', { autoAlpha:0, y:10 }, {
      autoAlpha:1, y:0, duration:.48, stagger:.065,
    }, .68)
    .addLabel('particle-arrival', PARTICLE_ENTRANCE_DELAY_SECONDS)
    .to(particleState, {
      entryProgress:1,
      duration:PARTICLE_ENTRANCE_DURATION_SECONDS,
      ease:'expo.out',
      onUpdate:renderParticles,
    }, 'particle-arrival');
}

function dismissWelcomeAnimation() {
  if (!overlay || dismissing) return;
  dismissing = true;
  stopAll();
  overlay.classList.add('hidden', 'is-exiting');
  overlay.dataset.animationState = 'exiting';

  if (reduceMotionQuery.matches) {
    overlay.style.removeProperty('opacity');
    overlay.classList.remove('is-exiting');
    overlay.dataset.animationState = 'hidden';
    dismissing = false;
    return;
  }

  gsap.set(overlay, { autoAlpha:1 });
  exit = gsap.timeline({
    onComplete:() => {
      exit = null;
      gsap.set(overlay, { clearProps:'opacity,visibility' });
      overlay.classList.remove('is-exiting');
      overlay.dataset.animationState = 'hidden';
      dismissing = false;
    },
  });
  exit
    .to('.w-visual', { autoAlpha:0, scale:.9, rotation:4, duration:.34, ease:'power3.in' }, 0)
    .to('.wcard', { autoAlpha:0, y:18, duration:.29, ease:'power2.in' }, .03)
    .to(shell, { autoAlpha:0, scale:.985, duration:.34, ease:'power2.inOut' }, .04)
    .to(overlay, { autoAlpha:0, duration:.38, ease:'power2.inOut' }, .04);
}

function onReducedMotionChange() {
  if (overlay?.classList.contains('hidden')) {
    stopAll();
    return;
  }
  playWelcomeAnimation();
}

function bindParticleInteraction() {
  if (!canvas) return;
  canvas.addEventListener('pointermove', event => {
    if (reduceMotionQuery.matches) return;
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) * canvasSide / rect.width;
    pointer.y = (event.clientY - rect.top) * canvasSide / rect.height;
    pointer.active = true;
  }, { passive:true });
  canvas.addEventListener('pointerleave', () => { pointer.active = false; });
  canvas.addEventListener('pointercancel', () => { pointer.active = false; });
}

function bindModeControls() {
  const controls = all('[data-lens-select]');
  const hoverTargets = [...controls, ...all('[data-lens-arc]')];
  const targetMode = target => target?.closest?.('[data-lens-select]')?.dataset.lensSelect ||
    target?.closest?.('[data-lens-arc]')?.dataset.lensArc || null;

  hoverTargets.forEach(target => {
    const mode = target.dataset.lensSelect || target.dataset.lensArc;
    target.addEventListener('pointerenter', () => {
      if (reduceMotionQuery.matches || overlay.classList.contains('hidden')) return;
      hoveredMode = mode;
      cycle?.kill();
      cycle = null;
      applyMode(mode);
      overlay.dataset.lensInteraction = 'hover';
    });
    target.addEventListener('pointerleave', event => {
      if (reduceMotionQuery.matches || targetMode(event.relatedTarget)) return;
      hoveredMode = null;
      overlay.dataset.lensInteraction = 'countdown';
      // Starting from the hovered mode gives it a full five-second dwell,
      // then advances to the next aspect and continues the normal loop.
      startModeCycle(currentMode);
    });
  });

  controls.forEach(button => {
    button.addEventListener('click', () => {
      const mode = button.dataset.lensSelect;
      applyMode(mode);
      if (!hoveredMode) startModeCycle(mode);
    });
  });
}

function handleVisibilityChange() {
  if (!overlay || overlay.classList.contains('hidden') || reduceMotionQuery.matches) return;
  if (document.hidden) {
    cycle?.pause(); pulse?.pause(); ringTweens.forEach(tween => tween.pause()); detachTicker();
  } else {
    cycle?.resume(); pulse?.resume(); ringTweens.forEach(tween => tween.resume()); attachTicker();
  }
}

reduceMotionQuery.addEventListener?.('change', onReducedMotionChange);
document.addEventListener('visibilitychange', handleVisibilityChange);

window.playWelcomeAnimation = playWelcomeAnimation;
window.dismissWelcomeAnimation = dismissWelcomeAnimation;
window.envWelcomeAnimation = {
  play:playWelcomeAnimation,
  dismiss:dismissWelcomeAnimation,
  selectMode:mode => {
    applyMode(mode);
    startModeCycle(mode);
  },
  getInfo:() => ({
    ready:!!overlay && !!canvas,
    engine:'gsap',
    reducedMotion:reduceMotionQuery.matches,
    state:overlay?.dataset.animationState || 'unavailable',
    mode:currentMode,
    cycleDurationMs:CYCLE_SECONDS * 1000,
    particlePulseCycleDurationMs:PARTICLE_PULSE_LEG_SECONDS * 2 * 1000,
    particleEntranceDelayMs:PARTICLE_ENTRANCE_DELAY_SECONDS * 1000,
    particleEntranceDurationMs:PARTICLE_ENTRANCE_DURATION_SECONDS * 1000,
    particleEntranceProgress:particleState.entryProgress,
    particleCount:particles.length,
    gridAxisPoints:particleGridSize,
    gridRadiusRatio:GRID_RADIUS_RATIO,
    particleFalloff:{
      centerRadiusRatio:canvasSide ? backgroundParticleStyle(0).radius / canvasSide : .0095,
      edgeRadiusRatio:canvasSide ? backgroundParticleStyle(canvasSide * GRID_RADIUS_RATIO).radius / canvasSide : .0024,
      centerOpacity:backgroundParticleStyle(0).opacity,
      edgeOpacity:backgroundParticleStyle(canvasSide * GRID_RADIUS_RATIO).opacity,
    },
    iconDotRadiusRatio:.01025,
    iconMaskScaleRatio:1 / 60,
    particleColor:[particleState.red, particleState.green, particleState.blue].map(Math.round),
    hoveredMode,
    cycling:!!cycle,
    ambientAnimations:ambientCount(),
  }),
};

if (overlay) {
  overlay.dataset.animationEngine = 'gsap';
  overlay.dataset.animationReady = 'true';
  buildLensTicks();
  bindModeControls();
  bindParticleInteraction();
  resizeObserver = new ResizeObserver(resizeParticleCanvas);
  resizeObserver.observe(canvas);
  new MutationObserver(() => {
    if (overlay.classList.contains('hidden') && !dismissing) {
      stopAll();
      gsap.set(overlay, { clearProps:'opacity,visibility' });
      overlay.dataset.animationState = 'hidden';
    }
  }).observe(overlay, { attributes:true, attributeFilter:['class'] });
  const playAfterLoad = () => requestAnimationFrame(playWelcomeAnimation);
  if (document.readyState === 'complete') playAfterLoad();
  else window.addEventListener('load', playAfterLoad, { once:true });
}
