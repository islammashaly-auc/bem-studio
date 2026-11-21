export const DEFAULT_ENERGY_PROPS = Object.freeze({
  occupancyDensity: 0.05,
  lightingPowerDensity: 9.0,
  equipmentPowerDensity: 15.0,
  hvacType: 'ideal',
  setpointHeating: 20,
  setpointCooling: 24,
  outdoorAirRate: 10,
  infiltrationACH: 0.5,
});

export const DEFAULT_CONSTRUCTIONS = Object.freeze({
  extWall: Object.freeze({ uValue: 0.35, heatCapacity: 150, reflectance: 0.50, thickness: 0.20 }),
  roof: Object.freeze({ uValue: 0.25, heatCapacity: 80, reflectance: 0.80, thickness: 0.20 }),
  interiorWall: Object.freeze({ uValue: 2.0, heatCapacity: 300, reflectance: 0.50, thickness: 0.20 }),
  slab: Object.freeze({ uValue: 2.0, heatCapacity: 300, reflectance: 0.20, thickness: 0.20 }),
  exposedFloor: Object.freeze({ uValue: 0.35, heatCapacity: 300, reflectance: 0.20, thickness: 0.20 }),
  groundFloor: Object.freeze({ uValue: 0.35, heatCapacity: 300, reflectance: 0.20, thickness: 0.20 }),
  door: Object.freeze({ uValue: 2.0, heatCapacity: 40, reflectance: 0.50, thickness: 0.05, massless: true }),
});

export const FILM_RESISTANCES = Object.freeze({
  wall: 0.17,
  roof: 0.14,
  exposedFloor: 0.21,
  groundFloor: 0.34,
  interior: 0.17,
});

export const ENERGYPLUS_ROUGHNESS = Object.freeze([
  'VeryRough', 'Rough', 'MediumRough', 'MediumSmooth', 'Smooth', 'VerySmooth',
]);

export function mergeEnergyProps(zoneProps = {}, override = {}) {
  return { ...DEFAULT_ENERGY_PROPS, ...zoneProps, ...override };
}

export function mergeConstructionDefaults(overrides = {}, materials = {}) {
  const out = {};
  for (const [key, base] of Object.entries(DEFAULT_CONSTRUCTIONS)) {
    const materialKey = key === 'extWall' || key === 'interiorWall' || key === 'door'
      ? 'walls'
      : key === 'roof'
        ? 'ceiling'
        : 'floor';
    out[key] = {
      ...base,
      reflectance: materials[materialKey] ?? base.reflectance,
      ...(overrides[key] || {}),
    };
  }
  return out;
}

export function constructionToMaterial(key, spec, filmResistance) {
  const uValue = spec.uValue;
  if (!(uValue > 0)) throw new Error(`${key} construction uValue must be > 0`);
  const rCond = Math.max(1 / uValue - filmResistance, 0.001);
  const solarAbs = 1 - (spec.reflectance ?? 0.5);
  const base = {
    roughness: 'MediumRough',
    thermal_absorptance: spec.thermalAbsorptance ?? 0.9,
    solar_absorptance: solarAbs,
    visible_absorptance: solarAbs,
  };
  if (spec.massless) {
    return { noMass: true, material: { ...base, thermal_resistance: rCond } };
  }
  const thickness = spec.thickness ?? 0.20;
  const specificHeat = spec.specificHeat ?? 1000;
  const density = (spec.heatCapacity ?? 150) * 1000 / (specificHeat * thickness);
  return {
    noMass: false,
    material: {
      ...base,
      thickness,
      conductivity: thickness / rCond,
      density,
      specific_heat: specificHeat,
    },
  };
}

/**
 * Validate and translate an ordered layered-construction specification.
 * Layers are always outside -> inside, matching EnergyPlus Construction.
 * Returns null for the legacy/simple equivalent-material mode.
 */
export function constructionToLayers(key, spec) {
  if (spec?.mode !== 'layered') return null;
  if (!Array.isArray(spec.layers) || spec.layers.length === 0) {
    throw new Error(`${key} layered construction requires at least one layer`);
  }
  if (spec.layers.length > 10) {
    throw new Error(`${key} layered construction supports at most 10 layers`);
  }

  const numberAbove = (value, minimum, label) => {
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= minimum) {
      throw new Error(`${key} ${label} must be > ${minimum}`);
    }
    return numeric;
  };
  const absorptance = (value, fallback, label) => {
    const numeric = value == null ? fallback : Number(value);
    if (!Number.isFinite(numeric) || numeric < 0 || numeric > 1) {
      throw new Error(`${key} ${label} must be between 0 and 1`);
    }
    return numeric;
  };
  const fallbackSolarAbsorptance = 1 - (spec.reflectance ?? 0.5);

  return spec.layers.map((source, index) => {
    const layer = source && typeof source === 'object' ? source : {};
    const type = ['solid', 'noMass', 'airGap'].includes(layer.type) ? layer.type : 'solid';
    const name = String(layer.name || `Layer ${index + 1}`).trim() || `Layer ${index + 1}`;
    if (type === 'airGap') {
      return {
        type,
        name,
        material: { thermal_resistance: numberAbove(layer.resistance, 0, `layer ${index + 1} resistance`) },
      };
    }

    const roughness = ENERGYPLUS_ROUGHNESS.includes(layer.roughness)
      ? layer.roughness : 'MediumRough';
    const surface = {
      roughness,
      thermal_absorptance: absorptance(layer.thermalAbsorptance, 0.9, `layer ${index + 1} thermal absorptance`),
      solar_absorptance: absorptance(layer.solarAbsorptance, fallbackSolarAbsorptance, `layer ${index + 1} solar absorptance`),
      visible_absorptance: absorptance(
        layer.visibleAbsorptance,
        layer.solarAbsorptance ?? fallbackSolarAbsorptance,
        `layer ${index + 1} visible absorptance`,
      ),
    };
    if (type === 'noMass') {
      return {
        type,
        name,
        material: {
          ...surface,
          thermal_resistance: numberAbove(layer.resistance, 0, `layer ${index + 1} resistance`),
        },
      };
    }
    const specificHeat = Number(layer.specificHeat);
    if (!Number.isFinite(specificHeat) || specificHeat < 100) {
      throw new Error(`${key} layer ${index + 1} specific heat must be at least 100`);
    }
    return {
      type,
      name,
      material: {
        ...surface,
        thickness: numberAbove(layer.thickness, 0, `layer ${index + 1} thickness`),
        conductivity: numberAbove(layer.conductivity, 0, `layer ${index + 1} conductivity`),
        density: numberAbove(layer.density, 0, `layer ${index + 1} density`),
        specific_heat: specificHeat,
      },
    };
  });
}
