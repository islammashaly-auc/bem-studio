/**
 * NCC 2022 Volume One — Section J screening and reference-model helpers.
 *
 * This module deliberately separates:
 *   - deterministic calculations that can be made from the BTM (J4/J7/J9);
 *   - project inputs and evidence that a practitioner must supply; and
 *   - the J1V3 simulation comparison.
 *
 * It is not a substitute for the NCC, referenced Standards, jurisdictional
 * variations, or a suitably qualified assessor.  Clause ids and table values
 * below are retained in results so every automated decision is auditable.
 */

export const NCC_SECTION_J_EDITION = 'NCC 2022 Volume One';

export const NCC_SECTION_J_SOURCES = Object.freeze({
  sectionJ:'https://ncc.abcb.gov.au/editions/ncc-2022/adopted/volume-one/j-energy-efficiency',
  j1v3:'https://ncc.abcb.gov.au/editions/ncc-2022/adopted/volume-one/j-energy-efficiency/part-j1-energy-efficiency-performance-requirements',
  specification33:'https://ncc.abcb.gov.au/editions/ncc-2022/adopted/volume-one/j-energy-efficiency/33-additional-requirements',
  specification34:'https://ncc.abcb.gov.au/editions/ncc-2022/adopted/volume-one/j-energy-efficiency/34-modelling-parameters-j1v3',
  specification35:'https://ncc.abcb.gov.au/editions/ncc-2022/adopted/volume-one/j-energy-efficiency/35-modelling-profiles-j1v3',
  specification37:'https://ncc.abcb.gov.au/editions/ncc-2022/adopted/volume-one/j-energy-efficiency/37-calculation-u-value-and-solar-admittance',
  facadeCalculator:'https://ncc.abcb.gov.au/resource/calculator/ncc-2022-volume-one-facade-calculator',
  climateMap:'https://ncc.abcb.gov.au/abcb-climate-map',
});

export const NCC_JURISDICTIONS = Object.freeze(['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA']);

export const NCC_CLIMATE_ZONES = Object.freeze({
  1:'High humidity summer, warm winter',
  2:'Warm humid summer, mild winter',
  3:'Hot dry summer, warm winter',
  4:'Hot dry summer, cool winter',
  5:'Warm temperate',
  6:'Mild temperate',
  7:'Cool temperate',
  8:'Alpine',
});

export const NCC_PROFILE_SOURCES = Object.freeze({
  'actual-2500-plus':Object.freeze({
    label:'Project-specific operating profile',
    description:'Uses the intended occupancy, HVAC, lighting and equipment schedules for this project. Under S34C3(6)(g), this is permitted when annual operation is at least 2,500 hours, or when the daily pattern is not listed in Specification 35.',
    hoursSource:'project',
  }),
  spec35:Object.freeze({
    label:'NCC Specification 35 profile',
    description:'Uses the NCC class/application-specific hourly profiles and internal gains for occupancy, HVAC, lighting, equipment and heated water.',
    hoursSource:'protocol',
  }),
  nabers:Object.freeze({
    label:'NABERS Energy simulation profile',
    description:'Uses the applicable NABERS Energy simulation requirements. Schedule hours and loads come from that protocol, not from a separate annual-hours entry.',
    hoursSource:'protocol',
  }),
  'green-star':Object.freeze({
    label:'Green Star simulation profile',
    description:'Uses the applicable Green Star simulation requirements. Schedule hours and loads come from that protocol, not from a separate annual-hours entry.',
    hoursSource:'protocol',
  }),
});

export const NCC_BUILDING_CLASSES = Object.freeze({
  '2-common': 'Class 2 common area',
  '3': 'Class 3',
  '5': 'Class 5',
  '6': 'Class 6',
  '7a': 'Class 7a',
  '7b': 'Class 7b',
  '8': 'Class 8',
  '9a-nonward': 'Class 9a · other than ward area',
  '9a-ward': 'Class 9a · ward area',
  '9b': 'Class 9b',
  '9c': 'Class 9c',
});

export const NCC_J1V3_CLASSES = Object.freeze(Object.keys(NCC_BUILDING_CLASSES));

// Table S34C3, kg CO2-e/GJ. ACT must be supplied from the ACT Appendix (or a
// current full-fuel-cycle factor selected by the assessor), hence null.
export const NCC_2022_EMISSIONS_FACTORS = Object.freeze({
  electricity: Object.freeze({ ACT:null, NSW:236, NT:162, QLD:254, SA:101, TAS:44, VIC:279, WA:191 }),
  gas: Object.freeze({ ACT:51.53, NSW:51.53, NT:51.53, QLD:51.53, SA:51.53, TAS:51.53, VIC:51.53, WA:51.53 }),
});

export const NCC_SECTION_J_DEFAULTS = Object.freeze({
  schema:'env-studio-ncc-section-j',
  version:1,
  enabled:false,
  edition:'ncc-2022',
  pathway:'j1v3',
  jurisdiction:'NSW',
  buildingClass:'5',
  climateZone:5,
  facadeMethod:'method1',
  profileSource:'actual-2500-plus',
  operatingHours:2500,
  actualProfileNotListedInSpec35:false,
  transitory:false,
  referenceShading:'remove-building-devices',
  electricityEmissionsFactor:null,
  gasEmissionsFactor:null,
  gasKWhProposed:0,
  gasKWhReference:0,
  onSiteRenewableKWh:0,
  reclaimedEnergyKWh:0,
  inSlabHeatingCooling:false,
  roofLightShaftIndex:0,
  lightingDefaults:Object.freeze({
    spaceType:'office-200-plus',
    targetIlluminance:320,
    controlFactors:Object.freeze([]),
    colourFactor:null,
    fixedDimmingLevel:1,
  }),
  lightingByZone:Object.freeze({}),
  evidence:Object.freeze({}),
  j9:Object.freeze({
    carparkSpacesByStorey:Object.freeze([]),
    installedPvRoofPercent:0,
    installedBattery:false,
    clearRoofPercent:0,
    roofAreaM2:null,
    roofMostlyShaded:false,
    specialUseRoofPercent:0,
  }),
  referenceServices:Object.freeze({
    heatingCOP:3,
    coolingCOP:3,
    fanPumpAllowancePct:10,
  }),
  comfortModel:Object.freeze({
    activityLevelWatts:120,
    clothing:0.7,
    airVelocity:0.1,
    workEfficiency:0,
  }),
});

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

function finite(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function bounded(value, min, max, fallback) {
  return Math.max(min, Math.min(max, finite(value, fallback)));
}

export function normalizeSectionJSettings(raw = {}) {
  const jurisdiction = NCC_JURISDICTIONS.includes(raw.jurisdiction)
    ? raw.jurisdiction : NCC_SECTION_J_DEFAULTS.jurisdiction;
  const buildingClass = Object.hasOwn(NCC_BUILDING_CLASSES, raw.buildingClass)
    ? raw.buildingClass : NCC_SECTION_J_DEFAULTS.buildingClass;
  const climateZone = Math.round(bounded(raw.climateZone, 1, 8, NCC_SECTION_J_DEFAULTS.climateZone));
  const defaultLighting = {
    ...clone(NCC_SECTION_J_DEFAULTS.lightingDefaults),
    ...(raw.lightingDefaults || {}),
  };
  defaultLighting.controlFactors = Array.isArray(defaultLighting.controlFactors)
    ? defaultLighting.controlFactors.filter(code => Object.hasOwn(NCC_LIGHTING_CONTROL_FACTORS, code)).slice(0, 2)
    : [];
  defaultLighting.colourFactor = Object.hasOwn(NCC_LIGHTING_COLOUR_FACTORS, defaultLighting.colourFactor)
    ? defaultLighting.colourFactor : null;
  defaultLighting.fixedDimmingLevel = bounded(defaultLighting.fixedDimmingLevel, 0, 1, 1);
  const lightingByZone = Object.fromEntries(Object.entries(raw.lightingByZone || {}).map(([zoneId, spec]) => [zoneId, {
    ...defaultLighting,
    ...(spec || {}),
    controlFactors:Array.isArray(spec?.controlFactors)
      ? spec.controlFactors.filter(code => Object.hasOwn(NCC_LIGHTING_CONTROL_FACTORS, code)).slice(0, 2)
      : [...defaultLighting.controlFactors],
  }]));
  const j9 = { ...clone(NCC_SECTION_J_DEFAULTS.j9), ...(raw.j9 || {}) };
  j9.carparkSpacesByStorey = Array.isArray(j9.carparkSpacesByStorey)
    ? j9.carparkSpacesByStorey.map(value => Math.max(0, Math.round(finite(value, 0)))) : [];
  j9.installedPvRoofPercent = bounded(j9.installedPvRoofPercent, 0, 100, 0);
  j9.clearRoofPercent = bounded(j9.clearRoofPercent, 0, 100, 0);
  j9.specialUseRoofPercent = bounded(j9.specialUseRoofPercent, 0, 100, 0);
  j9.roofAreaM2 = j9.roofAreaM2 == null || j9.roofAreaM2 === '' ? null : Math.max(0, finite(j9.roofAreaM2, 0));
  j9.installedBattery = j9.installedBattery === true;
  j9.roofMostlyShaded = j9.roofMostlyShaded === true;
  const referenceServices = { ...clone(NCC_SECTION_J_DEFAULTS.referenceServices), ...(raw.referenceServices || {}) };
  referenceServices.heatingCOP = bounded(referenceServices.heatingCOP, 0.1, 20, 3);
  referenceServices.coolingCOP = bounded(referenceServices.coolingCOP, 0.1, 20, 3);
  referenceServices.fanPumpAllowancePct = bounded(referenceServices.fanPumpAllowancePct, 0, 100, 10);
  const comfortModel = { ...clone(NCC_SECTION_J_DEFAULTS.comfortModel), ...(raw.comfortModel || {}) };
  comfortModel.activityLevelWatts = bounded(comfortModel.activityLevelWatts, 50, 500, 120);
  comfortModel.clothing = bounded(comfortModel.clothing, 0, 2, 0.7);
  comfortModel.airVelocity = bounded(comfortModel.airVelocity, 0, 2, 0.1);
  comfortModel.workEfficiency = bounded(comfortModel.workEfficiency, 0, 1, 0);
  return {
    ...clone(NCC_SECTION_J_DEFAULTS),
    ...raw,
    schema:'env-studio-ncc-section-j', version:1, edition:'ncc-2022',
    enabled:raw.enabled === true,
    pathway:['j1v3', 'dts'].includes(raw.pathway) ? raw.pathway : 'j1v3',
    jurisdiction, buildingClass, climateZone,
    facadeMethod:['method1', 'method2'].includes(raw.facadeMethod) ? raw.facadeMethod : 'method1',
    profileSource:Object.hasOwn(NCC_PROFILE_SOURCES, raw.profileSource)
      ? raw.profileSource : 'actual-2500-plus',
    operatingHours:Math.max(0, finite(raw.operatingHours, 2500)),
    actualProfileNotListedInSpec35:raw.actualProfileNotListedInSpec35 === true,
    transitory:raw.transitory === true,
    referenceShading:['remove-building-devices', 'retain-all'].includes(raw.referenceShading)
      ? raw.referenceShading : 'remove-building-devices',
    electricityEmissionsFactor:raw.electricityEmissionsFactor !== null && raw.electricityEmissionsFactor !== ''
      && Number.isFinite(Number(raw.electricityEmissionsFactor))
      ? Number(raw.electricityEmissionsFactor) : NCC_2022_EMISSIONS_FACTORS.electricity[jurisdiction],
    gasEmissionsFactor:raw.gasEmissionsFactor !== null && raw.gasEmissionsFactor !== ''
      && Number.isFinite(Number(raw.gasEmissionsFactor))
      ? Number(raw.gasEmissionsFactor) : NCC_2022_EMISSIONS_FACTORS.gas[jurisdiction],
    gasKWhProposed:Math.max(0, finite(raw.gasKWhProposed, 0)),
    gasKWhReference:Math.max(0, finite(raw.gasKWhReference, 0)),
    onSiteRenewableKWh:Math.max(0, finite(raw.onSiteRenewableKWh, 0)),
    reclaimedEnergyKWh:Math.max(0, finite(raw.reclaimedEnergyKWh, 0)),
    inSlabHeatingCooling:raw.inSlabHeatingCooling === true,
    roofLightShaftIndex:Math.max(0, finite(raw.roofLightShaftIndex, 0)),
    lightingDefaults:defaultLighting,
    lightingByZone,
    evidence:raw.evidence && typeof raw.evidence === 'object' ? clone(raw.evidence) : {},
    j9,
    referenceServices, comfortModel,
  };
}

const STANDARD_GROUP = new Set(['2-common', '5', '6', '7a', '7b', '8', '9a-nonward', '9b']);
const RESIDENTIAL_CARE_GROUP = new Set(['3', '9a-ward', '9c']);

export function nccClassGroup(buildingClass) {
  if (STANDARD_GROUP.has(buildingClass)) return 'standard';
  if (RESIDENTIAL_CARE_GROUP.has(buildingClass)) return 'residential-care';
  throw new Error(`Unsupported NCC building class "${buildingClass}"`);
}

const WALL_R_MIN = Object.freeze({
  standard:Object.freeze([null, 2.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4]),
  'residential-care':Object.freeze([null, 3.3, 1.4, 3.3, 2.8, 1.4, 2.8, 2.8, 3.8]),
});

const FACADE_U_MAX = Object.freeze({
  standard:Object.freeze([null, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0, 2.0]),
  'residential-care':Object.freeze([null, 1.1, 2.0, 1.1, 1.1, 2.0, 1.1, 1.1, 0.9]),
});

const SOLAR_ADMITTANCE_MAX = Object.freeze({
  standard:Object.freeze({
    1:{E:0.12,N:0.12,S:0.12,W:0.12}, 2:{E:0.13,N:0.13,S:0.13,W:0.13},
    3:{E:0.16,N:0.16,S:0.16,W:0.16}, 4:{E:0.13,N:0.13,S:0.13,W:0.13},
    5:{E:0.13,N:0.13,S:0.13,W:0.13}, 6:{E:0.13,N:0.13,S:0.13,W:0.13},
    7:{E:0.13,N:0.13,S:0.13,W:0.13}, 8:{E:0.20,N:0.20,S:0.42,W:0.36},
  }),
  'residential-care':Object.freeze({
    1:{E:0.07,N:0.07,S:0.10,W:0.07}, 2:{E:0.10,N:0.10,S:0.10,W:0.10},
    3:{E:0.07,N:0.07,S:0.07,W:0.07}, 4:{E:0.07,N:0.07,S:0.07,W:0.07},
    5:{E:0.10,N:0.10,S:0.10,W:0.10}, 6:{E:0.07,N:0.07,S:0.07,W:0.07},
    7:{E:0.07,N:0.07,S:0.08,W:0.07}, 8:{E:0.08,N:0.08,S:0.08,W:0.08},
  }),
});

const SOLAR_WEIGHTING = Object.freeze({
  standard:Object.freeze({
    N:[null,1.47,1.95,1.95,2.05,2.28,2.12,2.40,1.88],
    S:[null,1,1,1,1,1,1,1,1], E:[null,1.39,1.58,1.63,1.72,1.72,1.62,1.84,1.92],
    W:[null,1.41,1.68,1.65,1.69,1.75,1.67,1.92,1.25],
  }),
  'residential-care':Object.freeze({
    N:[null,1.42,1.77,1.72,1.55,1.88,1.52,1.60,1.24],
    S:[null,1,1,1,1,1,1,1,1], E:[null,1.30,1.49,1.48,1.37,1.48,1.28,1.35,1.26],
    W:[null,1.37,1.54,1.50,1.36,1.52,1.33,1.40,1.05],
  }),
});

export function nccEnvelopeTargets(settings = {}) {
  const normalized = normalizeSectionJSettings(settings);
  const group = nccClassGroup(normalized.buildingClass);
  const cz = normalized.climateZone;
  const roofR = cz === 8 ? 4.8 : cz === 6 ? 3.2 : 3.7;
  return {
    group,
    roofR,
    roofHeatFlow:cz >= 7 ? 'up' : 'down',
    roofSolarAbsorptanceMax:cz <= 7 ? 0.45 : null,
    wallR80:WALL_R_MIN[group][cz],
    wallRUnder80:1.0,
    facadeUMax:FACADE_U_MAX[group][cz],
    solarAdmittanceMax:{ ...SOLAR_ADMITTANCE_MAX[group][cz] },
    floorR:normalized.inSlabHeatingCooling ? (cz === 8 ? 4.75 : 3.25) : (cz === 8 ? 3.5 : 2.0),
    roofLightUMax:3.9,
    roofLightAreaRatioMax:0.05,
    clauses:{ roof:'J4D4', roofLights:'J4D5', facade:'J4D6', floors:'J4D7' },
  };
}

/** Table J4D5 — maximum roof-light Total System SHGC. */
export function nccRoofLightShgcMax(shaftIndex = 0, roofLightToFloorRatio = 0) {
  const ratio = Math.max(0, finite(roofLightToFloorRatio, 0));
  if (ratio > 0.05) return null;
  const column = ratio <= 0.035 ? 0 : 1;
  const index = Math.max(0, finite(shaftIndex, 0));
  if (index < 1) return [0.45, 0.29][column];
  if (index < 2.5) return [0.51, 0.33][column];
  return [0.76, 0.49][column];
}

const SHADING_TABLE_N_E_W = Object.freeze([
  [1.00,0.90,0.80,0.72,0.64,0.57,0.51,0.46,0.41,0.38,0.35],
  [1.00,0.95,0.89,0.81,0.74,0.66,0.59,0.52,0.47,0.42,0.40],
  [1.00,0.98,0.94,0.89,0.82,0.75,0.68,0.62,0.56,0.51,0.47],
  [1.00,1.00,0.97,0.94,0.89,0.84,0.78,0.72,0.66,0.61,0.57],
  [1.00,1.00,0.99,0.97,0.94,0.90,0.86,0.82,0.77,0.73,0.68],
  [1.00,1.00,1.00,0.99,0.97,0.95,0.92,0.90,0.86,0.83,0.79],
]);

const SHADING_TABLE_S = Object.freeze([
  [1.00,0.93,0.87,0.82,0.77,0.73,0.69,0.65,0.62,0.60,0.58],
  [1.00,0.97,0.93,0.88,0.84,0.79,0.75,0.71,0.67,0.64,0.62],
  [1.00,0.98,0.96,0.93,0.89,0.85,0.81,0.77,0.73,0.70,0.68],
  [1.00,0.99,0.98,0.96,0.93,0.90,0.87,0.83,0.80,0.77,0.74],
  [1.00,1.00,0.99,0.98,0.96,0.94,0.91,0.89,0.86,0.84,0.81],
  [1.00,1.00,0.99,0.99,0.98,0.96,0.95,0.93,0.91,0.90,0.88],
]);

function interpolateGrid(table, rowPosition, colPosition) {
  const r0 = Math.floor(rowPosition), r1 = Math.min(table.length - 1, Math.ceil(rowPosition));
  const c0 = Math.floor(colPosition), c1 = Math.min(table[0].length - 1, Math.ceil(colPosition));
  const rf = rowPosition - r0, cf = colPosition - c0;
  const top = table[r0][c0] * (1 - cf) + table[r0][c1] * cf;
  const bottom = table[r1][c0] * (1 - cf) + table[r1][c1] * cf;
  return top * (1 - rf) + bottom * rf;
}

/** Specification 37, Table S37C7a/b. Values between table points are linearly interpolated. */
export function nccShadingMultiplier({ aspect = 'N', gapToHeight = 0, projectionToHeight = 0 } = {}) {
  const gh = bounded(gapToHeight, 0, 0.5, 0);
  const ph = bounded(projectionToHeight, 0, 1, 0);
  const table = aspect === 'S' ? SHADING_TABLE_S : SHADING_TABLE_N_E_W;
  return interpolateGrid(table, gh * 10, ph * 10);
}

function normalizedFacade(facade) {
  const openings = Array.isArray(facade.openings) ? facade.openings.map(opening => ({
    ...opening,
    areaM2:Math.max(0, finite(opening.areaM2, 0)),
    uValue:Math.max(0, finite(opening.uValue, 0)),
    shgc:bounded(opening.shgc, 0, 1, 0),
    shadingMultiplier:bounded(opening.shadingMultiplier, 0, 1, 1),
  })) : [];
  const grossAreaM2 = Math.max(0, finite(facade.grossAreaM2, 0));
  const glazingAreaM2 = openings.reduce((sum, opening) => sum + opening.areaM2, 0);
  const opaqueAreaM2 = Math.max(0, grossAreaM2 - glazingAreaM2);
  return {
    ...facade,
    aspect:['N','E','S','W'].includes(facade.aspect) ? facade.aspect : 'N',
    grossAreaM2, glazingAreaM2, opaqueAreaM2, openings,
    opaqueR:Math.max(0.001, finite(facade.opaqueR, 0.001)),
  };
}

export function assessNccFacade(facades = [], settings = {}) {
  const normalizedSettings = normalizeSectionJSettings(settings);
  const targets = nccEnvelopeTargets(normalizedSettings);
  const rows = facades.map(normalizedFacade).filter(row => row.grossAreaM2 > 0).map(row => {
    const wallRatio = row.opaqueAreaM2 / row.grossAreaM2;
    const wallRRequired = wallRatio >= 0.8 ? targets.wallR80 : targets.wallRUnder80;
    const opaqueU = 1 / row.opaqueR;
    const totalUA = row.opaqueAreaM2 * opaqueU + row.openings.reduce(
      (sum, opening) => sum + opening.areaM2 * opening.uValue, 0);
    const totalSystemU = totalUA / row.grossAreaM2;
    const solarAdmittance = row.openings.reduce((sum, opening) =>
      sum + opening.areaM2 * opening.shadingMultiplier * opening.shgc, 0) / row.grossAreaM2;
    return {
      ...row, wallRatio, wallRRequired, opaqueU, totalSystemU, solarAdmittance,
      uLimit:targets.facadeUMax,
      solarLimit:targets.solarAdmittanceMax[row.aspect],
      wallRPass:row.opaqueR + 1e-9 >= wallRRequired,
      uPass:totalSystemU <= targets.facadeUMax + 1e-9,
      solarPass:solarAdmittance <= targets.solarAdmittanceMax[row.aspect] + 1e-9,
    };
  });
  const method1 = rows.length > 0 && rows.every(row => row.wallRPass && row.uPass && row.solarPass);
  const grossArea = rows.reduce((sum, row) => sum + row.grossAreaM2, 0);
  const combinedU = grossArea > 0
    ? rows.reduce((sum, row) => sum + row.totalSystemU * row.grossAreaM2, 0) / grossArea : null;
  const proposedEnergy = rows.reduce((sum, row) => {
    if (row.glazingAreaM2 / row.grossAreaM2 < 0.2) return sum;
    return sum + row.grossAreaM2 * SOLAR_WEIGHTING[targets.group][row.aspect][normalizedSettings.climateZone] * row.solarAdmittance;
  }, 0);
  const referenceEnergy = rows.reduce((sum, row) => {
    if (row.glazingAreaM2 / row.grossAreaM2 < 0.2) return sum;
    return sum + row.grossAreaM2 * SOLAR_WEIGHTING[targets.group][row.aspect][normalizedSettings.climateZone]
      * targets.solarAdmittanceMax[row.aspect];
  }, 0);
  const method2 = rows.length > 0 && rows.every(row => row.wallRPass)
    && combinedU != null && combinedU <= targets.facadeUMax + 1e-9
    && proposedEnergy <= referenceEnergy + 1e-9;
  return {
    clause:'J4D6 / Specification 37', method:normalizedSettings.facadeMethod,
    pass:normalizedSettings.facadeMethod === 'method2' ? method2 : method1,
    method1Pass:method1, method2Pass:method2,
    combinedU, uLimit:targets.facadeUMax,
    representativeSolarEnergy:{ proposed:proposedEnergy, reference:referenceEnergy },
    rows,
  };
}

/**
 * Produces the least-improving (limit-value) glazing inputs that make each
 * aspect comply with J4D6 Method 1 after applying the DTS wall R-value.
 */
export function buildNccReferenceFacade(facades = [], settings = {}) {
  const normalizedSettings = normalizeSectionJSettings(settings);
  const targets = nccEnvelopeTargets(normalizedSettings);
  const source = facades.map(normalizedFacade).filter(row => row.grossAreaM2 > 0);
  const wallR = source.reduce((required, row) => {
    const ratio = row.opaqueAreaM2 / row.grossAreaM2;
    return Math.max(required, ratio >= 0.8 ? targets.wallR80 : targets.wallRUnder80);
  }, targets.wallRUnder80);
  const wallU = 1 / wallR;
  const openingSpecs = {};
  const rows = source.map(row => {
    const availableUA = targets.facadeUMax * row.grossAreaM2 - wallU * row.opaqueAreaM2;
    // SimpleGlazingSystem's valid range tops out at 7 W/m²K. Cap at 5.8,
    // a conservative readily modelled single-glazing value, when a low WWR
    // would otherwise mathematically permit a poorer product.
    const glazingU = row.glazingAreaM2 > 0 ? bounded(availableUA / row.glazingAreaM2, 0.1, 5.8, 5.8) : null;
    const glazingShgc = row.glazingAreaM2 > 0
      ? bounded(targets.solarAdmittanceMax[row.aspect] * row.grossAreaM2 / row.glazingAreaM2, 0.01, 0.95, 0.95)
      : null;
    for (const opening of row.openings) {
      if (!opening.id) continue;
      openingSpecs[opening.id] = { uValue:glazingU, shgc:glazingShgc };
      if (opening.sourceOpeningId) openingSpecs[opening.sourceOpeningId] = { uValue:glazingU, shgc:glazingShgc };
    }
    return { aspect:row.aspect, grossAreaM2:row.grossAreaM2, glazingAreaM2:row.glazingAreaM2, glazingU, glazingShgc };
  });
  return {
    clause:'J4D6 / Specification 37', wallR, wallU, openingSpecs, rows,
    assumptions:['Method 1 used for the generated reference façade', 'No external building-device shading credit applied'],
  };
}

export function buildNccReferenceConstructions(facades = [], settings = {}) {
  const targets = nccEnvelopeTargets(settings);
  const facade = buildNccReferenceFacade(facades, settings);
  const spec = (rValue, reflectance, heatCapacity = 100) => ({
    uValue:1 / rValue, reflectance, heatCapacity, thickness:0.20,
  });
  return {
    facade,
    constructions:{
      extWall:spec(facade.wallR, 0.40, 150), // S34C2: external wall solar absorptance 0.6
      roof:spec(targets.roofR, targets.roofSolarAbsorptanceMax == null ? 0.55 : 1 - targets.roofSolarAbsorptanceMax, 80),
      exposedFloor:spec(targets.floorR, 0.20, 300),
      groundFloor:spec(targets.floorR, 0.20, 300),
      door:spec(facade.wallR, 0.40, 40),
    },
  };
}

export function createNccReferenceBtm(btm, openingSpecs = {}) {
  const copy = clone(btm);
  for (const zone of copy?.zones || []) {
    if (!zone.constructions) continue;
    for (const type of ['extWall','roof','exposedFloor','groundFloor','door','window']) {
      delete zone.constructions[type];
    }
  }
  for (const surface of copy?.surfaces || []) {
    for (const opening of [...(surface.windows || []), ...(surface.skylights || [])]) {
      const spec = openingSpecs[opening.id] || openingSpecs[opening._openingId];
      if (!spec || opening.subtype === 'door' || opening.isVoid) continue;
      opening.uValue = spec.uValue;
      opening.shgc = spec.shgc;
      opening.energyAssemblyId = null;
      opening.energyOverrides = { uValue:true, shgc:true };
    }
  }
  return copy;
}

export const NCC_LIGHTING_SPACE_TYPES = Object.freeze({
  'auditorium':{ label:'Auditorium, church or public hall', wattsPerM2:8 },
  'board-room':{ label:'Board / conference room', wattsPerM2:5 },
  'carpark-general':{ label:'Carpark · general', wattsPerM2:2 },
  'carpark-entry-day-15':{ label:'Carpark entry · first 15 m daytime', wattsPerM2:11.5 },
  'carpark-entry-day-next-4':{ label:'Carpark entry · next 4 m daytime', wattsPerM2:2.5 },
  'carpark-entry-night-20':{ label:'Carpark entry · first 20 m night', wattsPerM2:2.5 },
  'class2-common':{ label:'Class 2 common room / corridor', wattsPerM2:4.5 },
  'control-intermittent':{ label:'Control room · intermittent monitoring', wattsPerM2:3 },
  'control-constant':{ label:'Control room · constant monitoring', wattsPerM2:4.5 },
  'corridor':{ label:'Corridor', wattsPerM2:5 },
  'courtroom':{ label:'Courtroom', wattsPerM2:4.5 },
  'dormitory-sleep':{ label:'Class 3 dormitory · sleeping only', wattsPerM2:3 },
  'dormitory-study':{ label:'Class 3 dormitory · sleeping and study', wattsPerM2:4 },
  'entry-lobby':{ label:'Entry lobby from outside', wattsPerM2:9 },
  'health-child-emergency':{ label:'Health care · children / emergency', wattsPerM2:4 },
  'health-exam':{ label:'Health care · examination room', wattsPerM2:4.5 },
  'health-exam-intensive':{ label:'Health care · intensive exam room', wattsPerM2:6 },
  'health-other':{ label:'Health care · other patient care', wattsPerM2:2.5 },
  'kitchen':{ label:'Kitchen / food preparation', wattsPerM2:4 },
  'laboratory-400':{ label:'Laboratory · 400 lux or more', wattsPerM2:6 },
  'library-stack':{ label:'Library · stacks / shelving', wattsPerM2:2.5 },
  'library-reading':{ label:'Library · reading / general', wattsPerM2:4.5 },
  'class3-9c-lounge':{ label:'Class 3 / 9c communal lounge', wattsPerM2:4.5 },
  'museum-circulation':{ label:'Museum / gallery · circulation', wattsPerM2:2.5 },
  'office-200-plus':{ label:'Office · ambient 200 lux or more', wattsPerM2:4.5 },
  'office-under-200':{ label:'Office · ambient below 200 lux', wattsPerM2:2.5 },
  'plant-vertical-160':{ label:'Plant room · 160 lux vertical', wattsPerM2:4 },
  'plant-horizontal-80':{ label:'Plant room · 80 lux horizontal', wattsPerM2:2 },
  'restaurant':{ label:'Restaurant / café / bar / hotel lounge', wattsPerM2:14 },
  'retail':{ label:'Retail', wattsPerM2:14 },
  'school-general':{ label:'School · general learning / tutorial', wattsPerM2:4.5 },
  'class3-9c-sou':{ label:'Class 3 / 9c sole-occupancy unit', wattsPerM2:5 },
  'storage':{ label:'Storage', wattsPerM2:1.5 },
  'service':{ label:'Service / cleaner room', wattsPerM2:1.5 },
  'toilet':{ label:'Toilet / locker / staff / rest room', wattsPerM2:3 },
  'wholesale-storage':{ label:'Wholesale storage · 160 lux vertical', wattsPerM2:4 },
  'stair':{ label:'Stairway', wattsPerM2:2 },
  'lift-car':{ label:'Lift car', wattsPerM2:3 },
  'unlisted':{ label:'Unlisted · use target illuminance', wattsPerM2:null },
});

export const NCC_LIGHTING_CONTROL_FACTORS = Object.freeze({
  'motion-class6-toilet':{ label:'Motion · Class 6 toilet/change room', factor:0.4 },
  'motion-under-100':{ label:'Motion · controlled area <100 m²', factor:0.6 },
  'motion-100-plus':{ label:'Motion · controlled area ≥100 m²', factor:0.7 },
  'programmable-dimming':{ label:'Programmable dimming · ≥75% area', factor:0.85 },
  'fixed-dimming':{ label:'Fixed dimming', factor:null },
  'lumen-depreciation':{ label:'Lumen depreciation dimming', factor:0.85 },
  'two-stage-transitory':{ label:'Two-stage sensor · transitory / carpark', factor:0.7 },
  'two-stage-fire-stair':{ label:'Two-stage sensor · fire stair', factor:0.4 },
  'daylight-window-standard':{ label:'Daylight control · window zone', factor:0.5 },
  'daylight-window-care':{ label:'Daylight control · Class 3/9a ward/9c', factor:0.75 },
  'daylight-roof-standard':{ label:'Daylight control · roof light zone', factor:0.6 },
  'daylight-roof-care':{ label:'Daylight control · roof light Class 3/9a ward/9c', factor:0.8 },
});

export const NCC_LIGHTING_COLOUR_FACTORS = Object.freeze({
  'cri-90':{ label:'CRI ≥90', factor:0.9 },
  'cct-warm':{ label:'CCT ≤3500 K', factor:0.8 },
  'cct-cool':{ label:'CCT ≥4500 K', factor:1.1 },
});

function unlistedLightingPowerDensity(lux) {
  const value = Math.max(0, finite(lux, 0));
  if (value <= 80) return 2;
  if (value <= 160) return 2.5;
  if (value <= 240) return 3;
  if (value <= 320) return 4.5;
  if (value <= 400) return 6;
  if (value <= 600) return 10;
  return value <= 800 ? 11.5 : null;
}

function polygonPerimeter(points = []) {
  return points.reduce((sum, point, index) => {
    const next = points[(index + 1) % points.length];
    return sum + Math.hypot(next.x - point.x, next.y - point.y);
  }, 0);
}

export function calculateNccLightingAllowance(space = {}, { applyAdjustments = true } = {}) {
  const type = NCC_LIGHTING_SPACE_TYPES[space.spaceType] || NCC_LIGHTING_SPACE_TYPES.unlisted;
  const baseWPerM2 = type.wattsPerM2 ?? unlistedLightingPowerDensity(space.targetIlluminance);
  const areaM2 = Math.max(0, finite(space.areaM2, 0));
  const heightM = Math.max(0.01, finite(space.heightM, 0.01));
  const perimeterM = Math.max(0.01, finite(space.perimeterM, polygonPerimeter(space.footprint || [])));
  const roomAspectRatio = areaM2 / (heightM * perimeterM);
  const roomAspectFactor = applyAdjustments && roomAspectRatio < 1.5
    ? 0.5 + roomAspectRatio / 3 : 1;
  const factors = applyAdjustments && Array.isArray(space.controlFactors)
    ? space.controlFactors.map(code => {
        const item = NCC_LIGHTING_CONTROL_FACTORS[code];
        if (!item) return null;
        const factor = code === 'fixed-dimming'
          ? Math.max(0.5, 0.2 + 0.8 * bounded(space.fixedDimmingLevel, 0, 1, 1)) : item.factor;
        return { code, label:item.label, factor };
      }).filter(Boolean).sort((a, b) => a.factor - b.factor).slice(0, 2)
    : [];
  const controlFactor = factors.length > 1
    ? factors[0].factor * (factors[1].factor + (1 - factors[1].factor) / 2)
    : factors[0]?.factor ?? 1;
  const colourFactor = applyAdjustments && NCC_LIGHTING_COLOUR_FACTORS[space.colourFactor]
    ? NCC_LIGHTING_COLOUR_FACTORS[space.colourFactor].factor : 1;
  const totalFactor = roomAspectFactor * controlFactor * colourFactor;
  const allowedWPerM2 = baseWPerM2 == null ? null : baseWPerM2 / totalFactor;
  const designWPerM2 = Math.max(0, finite(space.designWPerM2, 0));
  return {
    clause:'J7D3', spaceType:space.spaceType, label:type.label, areaM2,
    baseWPerM2, allowedWPerM2, designWPerM2,
    allowanceW:allowedWPerM2 == null ? null : allowedWPerM2 * areaM2,
    designW:designWPerM2 * areaM2,
    roomAspectRatio, roomAspectFactor, controlFactors:factors, controlFactor, colourFactor,
    pass:allowedWPerM2 != null && designWPerM2 <= allowedWPerM2 + 1e-9,
    reason:baseWPerM2 == null ? 'J7D3 Table note only covers unlisted targets up to 800 lux' : null,
  };
}

export function assessNccLighting(spaces = [], options = {}) {
  const rows = spaces.map(space => calculateNccLightingAllowance(space, options));
  const allowanceW = rows.reduce((sum, row) => sum + (row.allowanceW || 0), 0);
  const designW = rows.reduce((sum, row) => sum + row.designW, 0);
  return {
    clause:'J7D3', rows, allowanceW, designW,
    pass:rows.length > 0 && rows.every(row => row.allowanceW != null) && designW <= allowanceW + 1e-9,
  };
}

export function lightingSpecForZone(settings, persistentId) {
  const normalized = normalizeSectionJSettings(settings);
  return { ...normalized.lightingDefaults, ...(normalized.lightingByZone[persistentId] || {}) };
}

export function nccReferenceEnergyProps(zones = [], settings = {}) {
  const normalized = normalizeSectionJSettings(settings);
  const setpointHeating = normalized.transitory ? 18 : 21;
  const setpointCooling = normalized.transitory ? 25 : 24;
  return Object.fromEntries(zones.map(zone => {
    const lighting = lightingSpecForZone(normalized, zone.persistentId || zone.id);
    const allowance = calculateNccLightingAllowance({
      ...lighting, areaM2:zone.floorArea, heightM:zone.height,
      footprint:zone.footprint, designWPerM2:0,
    }, { applyAdjustments:false });
    return [zone.id, {
      setpointHeating, setpointCooling,
      infiltrationACH:1, // actual 0.35/0.7 profile is requested separately from the exporter
      lightingPowerDensity:allowance.baseWPerM2,
    }];
  }));
}

export function nccEvReadyFraction(buildingClass) {
  if (buildingClass === '2-common') return 1;
  if (buildingClass === '5' || buildingClass === '6') return 0.10;
  if (['3','7b','8','9a-nonward','9a-ward','9b','9c'].includes(buildingClass)) return 0.20;
  return 0;
}

export function nccEvBoardsForReadySpaces(readySpaces) {
  const spaces = Math.max(0, Math.ceil(finite(readySpaces, 0)));
  if (spaces <= 9) return 0;
  return Math.ceil((spaces - 0) / 24);
}

export function assessNccJ9({ floorAreaM2 = 0, roofAreaM2 = 0 } = {}, settings = {}) {
  const normalized = normalizeSectionJSettings(settings);
  const j9 = normalized.j9;
  const evFraction = nccEvReadyFraction(normalized.buildingClass);
  const carpark = j9.carparkSpacesByStorey.map((spaces, index) => {
    const readySpaces = Math.ceil(spaces * evFraction);
    return { storey:index + 1, spaces, readySpaces, requiredBoards:nccEvBoardsForReadySpaces(readySpaces) };
  });
  const effectiveRoofArea = Math.max(0, j9.roofAreaM2 == null
    ? finite(roofAreaM2, 0) : finite(j9.roofAreaM2, roofAreaM2));
  const pvExempt = j9.installedPvRoofPercent >= 20 || j9.roofMostlyShaded === true
    || effectiveRoofArea <= 55 || j9.specialUseRoofPercent > 50;
  return {
    clauses:['J9D3','J9D4','J9D5'],
    monitoring:{
      floorAreaM2,
      wholeBuildingMetersRequired:floorAreaM2 > 500,
      endUseSubmetersRequired:floorAreaM2 > 2500,
    },
    ev:{ fraction:evFraction, carpark, totalRequiredBoards:carpark.reduce((sum, row) => sum + row.requiredBoards, 0) },
    pvBattery:{
      roofAreaM2:effectiveRoofArea,
      clearRoofPercentRequired:pvExempt ? 0 : 20,
      clearRoofPercentProvided:j9.clearRoofPercent,
      clearRoofPass:pvExempt || j9.clearRoofPercent >= 20,
      pvExempt,
      pvSwitchboardSpaceRequired:j9.installedPvRoofPercent < 20,
      batterySwitchboardSpaceRequired:j9.installedBattery !== true,
    },
  };
}

export const NCC_SECTION_J_EVIDENCE_ITEMS = Object.freeze([
  { part:'J2', clause:'J2D2', label:'Section J application, building classification and jurisdictional variation review' },
  { part:'J1V3', clause:'Spec 33', label:'J1V3 additional DTS requirements and exclusions review' },
  { part:'J1V3', clause:'S34C3', label:'Location, geometry, adjacent structures, profiles, loads and emissions modelling inputs' },
  { part:'J1V3', clause:'S34C4', label:'Detailed hourly HVAC system and plant part-load modelling (screen uses Ideal Loads only)' },
  { part:'J4', clause:'J4D3', label:'Thermal construction, insulation installation and thermal bridging evidence' },
  { part:'J4', clause:'J4D7(2)-(3)', label:'Slab edge insulation where in-slab heating/cooling is used' },
  { part:'J5', clause:'J5D3', label:'Chimney / flue damper' },
  { part:'J5', clause:'J5D4', label:'Roof-light sealing' },
  { part:'J5', clause:'J5D5', label:'Windows, doors, entrances and loading-dock sealing' },
  { part:'J5', clause:'J5D6', label:'Exhaust-fan sealing' },
  { part:'J5', clause:'J5D7', label:'Envelope construction sealing' },
  { part:'J5', clause:'J5D8', label:'Evaporative-cooler self-closing damper' },
  { part:'J6', clause:'J6D3', label:'Air-conditioning and ventilation controls / deactivation' },
  { part:'J6', clause:'J6D4', label:'Mechanical ventilation controls' },
  { part:'J6', clause:'J6D5', label:'Fan and duct systems' },
  { part:'J6', clause:'J6D6', label:'Ductwork insulation' },
  { part:'J6', clause:'J6D7', label:'Ductwork sealing' },
  { part:'J6', clause:'J6D8', label:'Pump systems and pipework pressure drop' },
  { part:'J6', clause:'J6D9', label:'Pipework insulation' },
  { part:'J6', clause:'J6D10', label:'Space heating' },
  { part:'J6', clause:'J6D11', label:'Refrigerant chillers' },
  { part:'J6', clause:'J6D12', label:'Unitary air-conditioning equipment' },
  { part:'J6', clause:'J6D13', label:'Heat rejection equipment' },
  { part:'J7', clause:'J7D4', label:'Interior lighting and power controls' },
  { part:'J7', clause:'J7D5', label:'Decorative and display lighting controls' },
  { part:'J7', clause:'J7D6', label:'Exterior artificial lighting controls' },
  { part:'J7', clause:'J7D7', label:'Boiling / chilled water unit time switch' },
  { part:'J7', clause:'J7D8', label:'Lift standby and efficiency class' },
  { part:'J7', clause:'J7D9', label:'Escalator / moving-walkway slow mode' },
  { part:'J8', clause:'J8D2', label:'Heated water supply compliance with NCC Volume Three Part B2' },
  { part:'J8', clause:'J8D3', label:'Swimming-pool heating, cover, timers and pipe insulation' },
  { part:'J8', clause:'J8D4', label:'Spa heating, cover, controls and pipe insulation' },
  { part:'J9', clause:'J9D3', label:'Energy monitoring and submetering facilities' },
  { part:'J9', clause:'J9D4', label:'Electric-vehicle charging readiness' },
  { part:'J9', clause:'J9D5', label:'Solar PV and battery readiness' },
]);

export function sectionJEvidenceSummary(settings = {}) {
  const normalized = normalizeSectionJSettings(settings);
  const rows = NCC_SECTION_J_EVIDENCE_ITEMS.map(item => {
    const evidence = normalized.evidence[item.clause] || {};
    const status = ['complies','not-applicable','does-not-comply'].includes(evidence.status)
      ? evidence.status : 'not-assessed';
    return { ...item, status, note:String(evidence.note || '') };
  });
  return {
    rows,
    counts:Object.fromEntries(['complies','not-applicable','does-not-comply','not-assessed'].map(
      status => [status, rows.filter(row => row.status === status).length])),
    pass:rows.every(row => row.status === 'complies' || row.status === 'not-applicable'),
  };
}

export function nccSiteElectricityKWh(streams = {}, services = {}) {
  const heatingCOP = Math.max(0.1, finite(services.heatingCOP, 3));
  const coolingCOP = Math.max(0.1, finite(services.coolingCOP, 3));
  const heating = Math.max(0, finite(streams.heating?.kWh ?? streams.heatingKWh, 0)) / heatingCOP;
  const cooling = Math.max(0, finite(streams.cooling?.kWh ?? streams.coolingKWh, 0)) / coolingCOP;
  const lighting = Math.max(0, finite(streams.lights?.kWh ?? streams.lightingKWh, 0));
  const equipment = Math.max(0, finite(streams.equipment?.kWh ?? streams.equipmentKWh, 0));
  const fanPump = (heating + cooling) * bounded(services.fanPumpAllowancePct, 0, 100, 10) / 100;
  return { heating, cooling, lighting, equipment, fanPump, total:heating + cooling + lighting + equipment + fanPump };
}

export function nccGreenhouseGas({ electricityKWh = 0, gasKWh = 0, offsetsKWh = 0 } = {}, settings = {}) {
  const normalized = normalizeSectionJSettings(settings);
  const electricityFactor = normalized.electricityEmissionsFactor;
  const gasFactor = normalized.gasEmissionsFactor;
  if (!(electricityFactor >= 0) || !(gasFactor >= 0)) return { kgCO2e:null, electricityFactor, gasFactor };
  const netElectricity = Math.max(0, electricityKWh - Math.max(0, offsetsKWh));
  return {
    kgCO2e:(netElectricity * electricityFactor + Math.max(0, gasKWh) * gasFactor) * 0.0036,
    electricityFactor, gasFactor, netElectricityKWh:netElectricity, gasKWh:Math.max(0, gasKWh),
  };
}

export function compareJ1V3Runs({ proposed, proposedReferenceServices, reference } = {}, settings = {}) {
  const normalized = normalizeSectionJSettings(settings);
  const proposedServices = proposed?.services || normalized.referenceServices;
  const proposedElectric = nccSiteElectricityKWh(proposed?.metrics?.streams, proposedServices);
  const sameServiceElectric = nccSiteElectricityKWh(proposedReferenceServices?.metrics?.streams, normalized.referenceServices);
  const referenceElectric = nccSiteElectricityKWh(reference?.metrics?.streams, normalized.referenceServices);
  const offsets = normalized.onSiteRenewableKWh + normalized.reclaimedEnergyKWh;
  const proposedGhg = nccGreenhouseGas({ electricityKWh:proposedElectric.total, gasKWh:normalized.gasKWhProposed, offsetsKWh:offsets }, normalized);
  const sameServiceGhg = nccGreenhouseGas({ electricityKWh:sameServiceElectric.total, gasKWh:normalized.gasKWhReference }, normalized);
  const referenceGhg = nccGreenhouseGas({ electricityKWh:referenceElectric.total, gasKWh:normalized.gasKWhReference }, normalized);
  const emissionsPass = proposedGhg.kgCO2e != null && referenceGhg.kgCO2e != null
    && proposedGhg.kgCO2e <= referenceGhg.kgCO2e + 1e-9;
  const envelopePass = sameServiceGhg.kgCO2e != null && referenceGhg.kgCO2e != null
    && sameServiceGhg.kgCO2e <= referenceGhg.kgCO2e + 1e-9;
  const comfort = proposed?.metrics?.comfort || null;
  const comfortPass = comfort?.complete === true && comfort?.areaPassingPercent >= 95;
  return {
    clause:'J1V3', proposedElectric, sameServiceElectric, referenceElectric,
    emissions:{ proposed:proposedGhg, proposedReferenceServices:sameServiceGhg, reference:referenceGhg },
    emissionsPass, envelopePass, comfort, comfortPass,
    pass:emissionsPass && envelopePass && comfortPass,
    screeningOnly:true,
    limitations:[
      'HVAC is represented by Ideal Loads plus fixed COP/fan-pump post-processing, not the detailed part-load plant required by S34C4.',
      'The result cannot be used as a compliance certificate until detailed services, Specification 33 evidence, profiles and jurisdictional variations are resolved.',
    ],
  };
}

export function validateSectionJRun(settings = {}, zones = []) {
  const normalized = normalizeSectionJSettings(settings);
  const errors = [], warnings = [];
  if (!NCC_J1V3_CLASSES.includes(normalized.buildingClass)) errors.push('Choose an NCC building class applicable to J1V3.');
  if (normalized.pathway === 'j1v3' && normalized.profileSource === 'actual-2500-plus'
    && normalized.operatingHours < 2500 && !normalized.actualProfileNotListedInSpec35) {
    errors.push('A project-specific profile below 2,500 operating hours requires confirmation that its daily pattern is not listed in Specification 35 (S34C3(6)(g)).');
  }
  if (normalized.electricityEmissionsFactor == null) errors.push('Enter the applicable ACT/current electricity emissions factor.');
  if (!zones.length) errors.push('The model has no conditioned zones.');
  for (const zone of zones) {
    const lighting = lightingSpecForZone(normalized, zone.persistentId || zone.id);
    const base = NCC_LIGHTING_SPACE_TYPES[lighting.spaceType]?.wattsPerM2
      ?? unlistedLightingPowerDensity(lighting.targetIlluminance);
    if (base == null) errors.push(`${zone.name || zone.id}: enter a supported lighting space type or a target illuminance not above 800 lux.`);
  }
  if (normalized.jurisdiction === 'NT') errors.push('NCC 2022 Section J is replaced in the Northern Territory; this NCC 2022 ruleset cannot be used for NT compliance.');
  if (normalized.jurisdiction === 'TAS' && normalized.buildingClass === '2-common') {
    errors.push('Tasmania replaces Section J for Class 2 with BCA 2019 Amendment 1; this NCC 2022 ruleset is not applicable.');
  }
  if (normalized.jurisdiction === 'NSW' && normalized.buildingClass === '2-common') {
    warnings.push('NSW Class 2 applicability depends on the BASIX certificate version; confirm the consent pathway and applicable edition.');
  }
  if (normalized.profileSource !== 'actual-2500-plus') {
    warnings.push(`${NCC_PROFILE_SOURCES[normalized.profileSource].label} is recorded as the profile basis, but this screening build does not substitute that protocol automatically; configure and evidence matching profiles under Energy schedules.`);
  }
  warnings.push('NCC 2025 became available for jurisdictions to consider from 1 May 2026; confirm the edition adopted for the project before using this NCC 2022 ruleset.');
  warnings.push('This implementation currently provides an early-design J1V3 screen; detailed HVAC/plant compliance remains a manual-review item.');
  return { settings:normalized, errors, warnings, valid:errors.length === 0 };
}
