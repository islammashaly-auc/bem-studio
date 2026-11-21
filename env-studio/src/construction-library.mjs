const surface = (roughness = 'MediumRough', thermalAbsorptance = 0.9,
  solarAbsorptance = 0.7, visibleAbsorptance = solarAbsorptance) => ({
  roughness, thermalAbsorptance, solarAbsorptance, visibleAbsorptance,
});

const solid = (id, name, defaultThickness, conductivity, density, specificHeat, props = {}) => ({
  id, name, type:'solid', defaultThickness, conductivity, density, specificHeat,
  ...surface(), ...props,
});

const noMass = (id, name, resistance, props = {}) => ({
  id, name, type:'noMass', resistance, ...surface(), ...props,
});

const airGap = (id, name, resistance) => ({ id, name, type:'airGap', resistance });

const glazing = (id, name, uFactor, shgc, visibleTransmittance) => ({
  id, name, type:'simpleGlazing', uFactor, shgc, visibleTransmittance,
});

const MATERIALS = [
  solid('mat-cement-render', 'Cement render', 0.020, 0.72, 1860, 840,
    surface('MediumRough', 0.90, 0.65, 0.65)),
  solid('mat-gypsum-plaster', 'Gypsum plaster', 0.013, 0.16, 800, 1090,
    surface('Smooth', 0.90, 0.50, 0.50)),
  solid('mat-facing-brick', 'Facing brick', 0.100, 0.72, 1800, 840,
    surface('Rough', 0.90, 0.68, 0.66)),
  solid('mat-clay-brick', 'Clay brick', 0.120, 0.72, 1700, 840,
    surface('MediumRough', 0.90, 0.70, 0.70)),
  solid('mat-concrete-block', 'Concrete block', 0.150, 0.51, 1400, 1000,
    surface('MediumRough', 0.90, 0.65, 0.65)),
  solid('mat-reinforced-concrete', 'Reinforced concrete', 0.200, 1.70, 2300, 880,
    surface('MediumRough', 0.90, 0.65, 0.65)),
  solid('mat-cement-screed', 'Cement screed', 0.040, 1.40, 2000, 840,
    surface('MediumRough', 0.90, 0.65, 0.65)),
  solid('mat-ceramic-tile', 'Ceramic tile', 0.012, 1.30, 2300, 840,
    surface('Smooth', 0.90, 0.42, 0.42)),
  solid('mat-xps-insulation', 'XPS insulation', 0.060, 0.034, 35, 1450,
    surface('MediumSmooth', 0.90, 0.55, 0.55)),
  solid('mat-mineral-wool', 'Mineral wool', 0.080, 0.040, 40, 840,
    surface('MediumRough', 0.90, 0.55, 0.55)),
  noMass('mat-waterproof-membrane', 'Waterproof membrane', 0.020,
    surface('VeryRough', 0.90, 0.30, 0.30)),
  airGap('mat-air-gap-vertical', 'Unventilated vertical air gap', 0.180),
  airGap('mat-air-gap-horizontal', 'Unventilated horizontal air gap', 0.160),
  glazing('mat-window-single-clear', 'Single clear glazing', 5.70, 0.82, 0.88),
  glazing('mat-window-single-tinted', 'Single tinted glazing', 5.70, 0.58, 0.50),
  glazing('mat-window-single-low-e-clear', 'Single low-e clear glazing', 3.80, 0.63, 0.70),
  glazing('mat-window-single-low-e-tinted', 'Single low-e tinted glazing', 3.80, 0.42, 0.45),
  glazing('mat-window-double-clear', 'Double clear glazing', 2.70, 0.70, 0.78),
  glazing('mat-window-double-low-e', 'Double low-e glazing', 1.60, 0.40, 0.65),
];

const layer = (materialId, thickness = undefined, resistance = undefined) => ({
  materialId,
  ...(thickness == null ? {} : { thickness }),
  ...(resistance == null ? {} : { resistance }),
});

const ASSEMBLIES = [
  {
    id:'asm-wall-insulated-masonry', name:'Insulated masonry wall', category:'wall',
    layers:[
      layer('mat-cement-render', 0.020), layer('mat-clay-brick', 0.120),
      layer('mat-xps-insulation', 0.060), layer('mat-concrete-block', 0.100),
      layer('mat-gypsum-plaster', 0.013),
    ],
  },
  {
    id:'asm-wall-insulated-cavity', name:'Insulated cavity wall', category:'wall',
    layers:[
      layer('mat-facing-brick', 0.100), layer('mat-air-gap-vertical', undefined, 0.180),
      layer('mat-mineral-wool', 0.060), layer('mat-concrete-block', 0.100),
      layer('mat-gypsum-plaster', 0.013),
    ],
  },
  {
    id:'asm-wall-concrete', name:'Concrete wall', category:'wall',
    layers:[layer('mat-cement-render', 0.020), layer('mat-reinforced-concrete', 0.200), layer('mat-gypsum-plaster', 0.013)],
  },
  {
    id:'asm-wall-interior-block', name:'Interior block partition', category:'wall',
    layers:[layer('mat-gypsum-plaster', 0.013), layer('mat-concrete-block', 0.100), layer('mat-gypsum-plaster', 0.013)],
  },
  {
    id:'asm-roof-insulated-concrete', name:'Insulated concrete roof', category:'roof',
    layers:[
      layer('mat-waterproof-membrane', undefined, 0.020), layer('mat-cement-screed', 0.040),
      layer('mat-xps-insulation', 0.080), layer('mat-reinforced-concrete', 0.200),
      layer('mat-gypsum-plaster', 0.013),
    ],
  },
  {
    id:'asm-roof-concrete', name:'Uninsulated concrete roof', category:'roof',
    layers:[layer('mat-waterproof-membrane', undefined, 0.020), layer('mat-cement-screed', 0.040), layer('mat-reinforced-concrete', 0.200), layer('mat-gypsum-plaster', 0.013)],
  },
  {
    id:'asm-floor-ground-insulated', name:'Insulated ground slab', category:'floor',
    layers:[layer('mat-xps-insulation', 0.050), layer('mat-reinforced-concrete', 0.180), layer('mat-cement-screed', 0.040), layer('mat-ceramic-tile', 0.012)],
  },
  {
    id:'asm-floor-interior-slab', name:'Interior concrete slab', category:'floor',
    layers:[layer('mat-gypsum-plaster', 0.013), layer('mat-reinforced-concrete', 0.180), layer('mat-cement-screed', 0.040), layer('mat-ceramic-tile', 0.012)],
  },
  {
    id:'asm-floor-exposed-insulated', name:'Insulated exposed floor', category:'floor',
    layers:[layer('mat-cement-render', 0.020), layer('mat-mineral-wool', 0.080), layer('mat-reinforced-concrete', 0.180), layer('mat-cement-screed', 0.040), layer('mat-ceramic-tile', 0.012)],
  },
  {
    id:'asm-window-single-clear', name:'Single clear window', category:'window',
    layers:[layer('mat-window-single-clear')],
  },
  {
    id:'asm-window-single-tinted', name:'Single tinted window', category:'window',
    layers:[layer('mat-window-single-tinted')],
  },
  {
    id:'asm-window-single-low-e-clear', name:'Single low-e clear window', category:'window',
    layers:[layer('mat-window-single-low-e-clear')],
  },
  {
    id:'asm-window-single-low-e-tinted', name:'Single low-e tinted window', category:'window',
    layers:[layer('mat-window-single-low-e-tinted')],
  },
  {
    id:'asm-window-double-clear', name:'Double clear window', category:'window',
    layers:[layer('mat-window-double-clear')],
  },
  {
    id:'asm-window-double-low-e', name:'Double low-e window', category:'window',
    layers:[layer('mat-window-double-low-e')],
  },
];

function deepFreeze(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

export const NATIVE_CONSTRUCTION_LIBRARY = deepFreeze({
  schema:'env-studio-construction-library', version:1,
  materials:MATERIALS, assemblies:ASSEMBLIES,
});

export const DEFAULT_ASSEMBLY_IDS = Object.freeze({
  extWall:'asm-wall-insulated-masonry',
  interiorWall:'asm-wall-interior-block',
  roof:'asm-roof-insulated-concrete',
  slab:'asm-floor-interior-slab',
  exposedFloor:'asm-floor-exposed-insulated',
  groundFloor:'asm-floor-ground-insulated',
  window:'asm-window-double-low-e',
});

export const CONSTRUCTION_TYPE_CATEGORIES = Object.freeze({
  extWall:'wall', interiorWall:'wall', door:'wall', roof:'roof',
  slab:'floor', exposedFloor:'floor', groundFloor:'floor', window:'window',
});

export function normalizeCustomConstructionLibrary(raw = {}) {
  return {
    schema:'env-studio-construction-library', version:1,
    materials:Array.isArray(raw?.materials) ? raw.materials.map(item => ({...item})) : [],
    assemblies:Array.isArray(raw?.assemblies)
      ? raw.assemblies.map(item => ({...item, layers:Array.isArray(item.layers) ? item.layers.map(entry => ({...entry})) : []}))
      : [],
  };
}

export function combinedConstructionLibrary(custom = {}) {
  const normalized = normalizeCustomConstructionLibrary(custom);
  return {
    materials:[...NATIVE_CONSTRUCTION_LIBRARY.materials, ...normalized.materials],
    assemblies:[...NATIVE_CONSTRUCTION_LIBRARY.assemblies, ...normalized.assemblies],
  };
}

export function assemblyCategoryForType(type) {
  return CONSTRUCTION_TYPE_CATEGORIES[type] || null;
}

export function findLibraryMaterial(id, custom = {}) {
  return combinedConstructionLibrary(custom).materials.find(item => item.id === id) || null;
}

export function findLibraryAssembly(id, custom = {}) {
  return combinedConstructionLibrary(custom).assemblies.find(item => item.id === id) || null;
}

export function assembliesForType(type, custom = {}) {
  const category = assemblyCategoryForType(type);
  return combinedConstructionLibrary(custom).assemblies.filter(item => item.category === category);
}

function positive(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) throw new Error(`${label} must be > 0`);
  return numeric;
}

function bounded(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) throw new Error(`${label} must be between 0 and 1`);
  return numeric;
}

export function resolveAssemblyLayers(assemblyOrId, custom = {}) {
  const assembly = typeof assemblyOrId === 'string'
    ? findLibraryAssembly(assemblyOrId, custom) : assemblyOrId;
  if (!assembly) throw new Error(`Unknown construction assembly "${assemblyOrId}"`);
  if (!Array.isArray(assembly.layers) || !assembly.layers.length) throw new Error(`${assembly.name || assembly.id} has no layers`);
  if (assembly.layers.length > 10) throw new Error(`${assembly.name || assembly.id} supports at most 10 layers`);
  const resolved = assembly.layers.map((entry, index) => {
    const material = findLibraryMaterial(entry.materialId, custom);
    if (!material) throw new Error(`${assembly.name || assembly.id} layer ${index + 1} references an unknown material`);
    return { entry, material };
  });
  if (assembly.category !== 'window' &&
      (resolved[0].material.type === 'airGap' || resolved.at(-1).material.type === 'airGap')) {
    throw new Error(`${assembly.name || assembly.id} air gaps must be between solid or massless layers`);
  }
  return resolved;
}

export function calculateAssemblyPerformance(assemblyOrId, custom = {}) {
  const assembly = typeof assemblyOrId === 'string'
    ? findLibraryAssembly(assemblyOrId, custom) : assemblyOrId;
  const resolved = resolveAssemblyLayers(assembly, custom);
  if (assembly.category === 'window') {
    if (resolved.length !== 1 || resolved[0].material.type !== 'simpleGlazing') {
      throw new Error(`${assembly.name || assembly.id} must contain one SimpleGlazing layer`);
    }
    const material = resolved[0].material;
    const uValue = positive(material.uFactor, `${material.name} U-factor`);
    return {
      category:'window', rValue:1 / uValue, uValue,
      heatCapacity:0, shgc:bounded(material.shgc, `${material.name} SHGC`),
      visibleTransmittance:bounded(material.visibleTransmittance, `${material.name} visible transmittance`),
      solarAbsorptance:null, thermalAbsorptance:null, roughness:null,
    };
  }

  let rValue = 0;
  let heatCapacity = 0;
  for (const { entry, material } of resolved) {
    if (material.type === 'simpleGlazing') throw new Error(`${material.name} cannot be used in an opaque assembly`);
    if (material.type === 'solid') {
      const thickness = positive(entry.thickness ?? material.defaultThickness, `${material.name} thickness`);
      rValue += thickness / positive(material.conductivity, `${material.name} conductivity`);
      heatCapacity += thickness * positive(material.density, `${material.name} density`) *
        positive(material.specificHeat, `${material.name} specific heat`) / 1000;
    } else {
      rValue += positive(entry.resistance ?? material.resistance, `${material.name} resistance`);
    }
  }
  const outsideMaterial = resolved.find(({ material }) => material.type !== 'airGap')?.material;
  return {
    category:assembly.category, rValue, uValue:1 / rValue, heatCapacity,
    solarAbsorptance:outsideMaterial?.solarAbsorptance ?? null,
    thermalAbsorptance:outsideMaterial?.thermalAbsorptance ?? null,
    visibleAbsorptance:outsideMaterial?.visibleAbsorptance ?? null,
    roughness:outsideMaterial?.roughness ?? null,
  };
}

export function assemblyToConstructionSpec(assemblyId, custom = {}) {
  const assembly = findLibraryAssembly(assemblyId, custom);
  if (!assembly) throw new Error(`Unknown construction assembly "${assemblyId}"`);
  if (assembly.category === 'window') throw new Error(`${assembly.name} is a window assembly, not an opaque construction`);
  const layers = resolveAssemblyLayers(assembly, custom).map(({ entry, material }) => {
    const common = { name:material.name, type:material.type };
    if (material.type === 'airGap') {
      return { ...common, resistance:positive(entry.resistance ?? material.resistance, `${material.name} resistance`) };
    }
    const surfaceProps = {
      roughness:material.roughness,
      thermalAbsorptance:bounded(material.thermalAbsorptance, `${material.name} thermal absorptance`),
      solarAbsorptance:bounded(material.solarAbsorptance, `${material.name} solar absorptance`),
      visibleAbsorptance:bounded(material.visibleAbsorptance, `${material.name} visible absorptance`),
    };
    if (material.type === 'noMass') {
      return { ...common, ...surfaceProps, resistance:positive(entry.resistance ?? material.resistance, `${material.name} resistance`) };
    }
    return {
      ...common, ...surfaceProps,
      thickness:positive(entry.thickness ?? material.defaultThickness, `${material.name} thickness`),
      conductivity:positive(material.conductivity, `${material.name} conductivity`),
      density:positive(material.density, `${material.name} density`),
      specificHeat:positive(material.specificHeat, `${material.name} specific heat`),
    };
  });
  return { mode:'layered', layers };
}

export function assemblyToWindowSpec(assemblyId, custom = {}) {
  const assembly = findLibraryAssembly(assemblyId, custom);
  if (!assembly) throw new Error(`Unknown window assembly "${assemblyId}"`);
  const performance = calculateAssemblyPerformance(assembly, custom);
  if (performance.category !== 'window') throw new Error(`${assembly.name} is not a window assembly`);
  return {
    uValue:performance.uValue,
    shgc:performance.shgc,
    vt:performance.visibleTransmittance,
  };
}
