/**
 * LEED v5 BD+C New Construction — Appendix G automation and screening.
 *
 * The module automates the decisions that the current BTM and Ideal Loads
 * engine can represent: LEED future-source BPFs, baseline WWR, 90.1-2019
 * envelope targets, whole-building lighting power, baseline HVAC system
 * classification, heat source and four baseline rotations. Decisions that
 * require data the editor does not yet collect remain explicit QA blockers;
 * they are never replaced with an unlabelled user-entered "verified" value.
 */

export const LEED_V5_BDC_SOURCES = Object.freeze({
  ratingSystem:'https://www.usgbc.org/leed/v5',
  simulationReport:'https://www.usgbc.org/sites/default/files/LEEDv5Resources/LEED%20v5%20D%2BC%20Energy%20Simulation%20Report.pdf',
  simulationAppendices:'https://www.usgbc.org/sites/default/files/LEEDv5Resources/LEED%20v5%20D%2BC_Energy%20Simulation%20Report%20Appendices.pdf',
  addenda:'https://www.usgbc.org/sites/default/files/2026-02/LEED%20v5%20BD%2BC%20Addenda%20Table%20-%20only_02-20-2026.pdf',
  doeComplianceForm:'https://www.energycodes.gov/ashrae-standard-901-performance-based-compliance-form',
  doeBpfCalculator:'https://www.energycodes.gov/sites/default/files/2024-06/AppendixG_coeff_bpf_June_2024_Final.xlsx',
  doePrmManual:'https://www.pnnl.gov/main/publications/external/technical_reports/PNNL-36136.pdf',
  openstudioStandards:'https://github.com/NREL/openstudio-standards/tree/master/lib/openstudio-standards/standards/ashrae_90_1_prm/ashrae_90_1_prm_2019',
});

export const LEED_ASHRAE_EDITIONS = Object.freeze({
  '90.1-2019':'ASHRAE 90.1-2019 · automated baseline',
  '90.1-2022':'ASHRAE 90.1-2022 · BPF only; baseline dataset pending',
});

export const LEED_BUILDING_AREA_TYPES = Object.freeze({
  office:'Office', retail:'Retail', school:'School', warehouse:'Warehouse',
  hotel:'Hotel / motel', multifamily:'Multifamily', healthcare:'Healthcare / hospital',
  restaurant:'Restaurant', 'all-others':'All others', mixed:'Mixed use',
});

export const LEED_BUILDING_SUBTYPES = Object.freeze({
  office:Object.freeze({ automatic:'Automatic from floor area' }),
  retail:Object.freeze({ standalone:'Standalone retail', strip:'Strip mall', grocery:'Grocery store' }),
  school:Object.freeze({ primary:'Primary / secondary school', university:'University' }),
  warehouse:Object.freeze({ nonrefrigerated:'Non-refrigerated warehouse', refrigerated:'Refrigerated warehouse' }),
  hotel:Object.freeze({ automatic:'Automatic from guest-room count' }),
  multifamily:Object.freeze({ residential:'Residential / apartment' }),
  healthcare:Object.freeze({ outpatient:'Outpatient clinic', hospital:'Hospital' }),
  restaurant:Object.freeze({ full:'Full-service restaurant', quick:'Quick-service restaurant', bar:'Bar / lounge' }),
  'all-others':Object.freeze({ other:'Other nonresidential', 'public-assembly':'Public assembly' }),
  mixed:Object.freeze({ mixed:'Area-weighted mix' }),
});

export const LEED_CLIMATE_ZONES = Object.freeze([
  '0A','0B','1A','1B','2A','2B','3A','3B','3C','4A','4B','4C',
  '5A','5B','5C','6A','6B','7','8',
]);

export const LEED_V5_POINT_THRESHOLDS = Object.freeze({
  excludingRenewables:Object.freeze([3,6,9,12,15,18,21,24,27,30]),
  includingRenewables:Object.freeze([10,20,30,40,50,60,70,80,90,100]),
});

const BPF_2019 = Object.freeze({
  multifamily:[.74,.69,.73,.70,.73,.70,.71,.70,.63,.70,.71,.69,.68,.70,.70,.68,.68,.68,.74],
  healthcare:[.72,.72,.73,.73,.74,.71,.72,.74,.71,.72,.73,.71,.74,.73,.80,.73,.77,.78,.79],
  hotel:[.72,.71,.72,.71,.71,.70,.71,.73,.72,.71,.73,.73,.71,.73,.74,.70,.72,.70,.70],
  office:[.62,.63,.61,.62,.58,.60,.57,.62,.55,.55,.61,.57,.58,.61,.59,.58,.60,.54,.58],
  restaurant:[.65,.62,.63,.61,.62,.58,.63,.63,.63,.67,.66,.66,.70,.70,.68,.73,.72,.74,.77],
  retail:[.57,.54,.53,.53,.48,.47,.47,.47,.47,.52,.50,.56,.57,.53,.59,.58,.56,.53,.60],
  school:[.57,.57,.58,.57,.55,.54,.57,.51,.49,.48,.51,.52,.51,.53,.51,.53,.50,.51,.58],
  warehouse:[.28,.30,.24,.27,.23,.24,.27,.23,.20,.33,.26,.28,.40,.32,.29,.44,.38,.40,.44],
  'all-others':[.65,.62,.64,.62,.57,.54,.57,.56,.58,.59,.57,.60,.60,.59,.65,.62,.62,.61,.64],
});

// Calculated from the DOE/PNNL June 2024 Appendix G 90.1-2022 A/B/C
// coefficient dataset with LEED's future electric source factor of 2.0 and
// unit future source factor for direct fuel. Values are rounded to 0.01 in
// the same manner as the DOE calculator. They are used for EAp2 only; the
// New Construction credit uses the LEED 2019-equivalent table above.
const BPF_2022 = Object.freeze({
  multifamily:[.70,.69,.73,.71,.73,.74,.74,.75,.66,.65,.73,.68,.61,.68,.67,.59,.61,.59,.61],
  healthcare:[.69,.68,.70,.67,.66,.63,.64,.65,.64,.63,.65,.62,.66,.64,.66,.66,.67,.68,.70],
  hotel:[.67,.67,.70,.66,.67,.65,.66,.67,.67,.64,.66,.65,.62,.65,.65,.61,.63,.59,.58],
  office:[.54,.54,.53,.52,.52,.52,.50,.54,.48,.47,.53,.48,.49,.52,.49,.48,.50,.45,.47],
  restaurant:[.63,.60,.58,.58,.58,.54,.58,.57,.55,.60,.59,.59,.63,.62,.61,.65,.64,.67,.69],
  retail:[.51,.49,.48,.48,.44,.43,.43,.43,.44,.44,.44,.47,.46,.44,.49,.47,.46,.44,.46],
  school:[.52,.57,.57,.56,.52,.53,.53,.50,.51,.44,.47,.49,.46,.48,.48,.45,.43,.43,.45],
  warehouse:[.26,.26,.22,.25,.21,.22,.25,.21,.18,.30,.24,.26,.36,.30,.26,.40,.34,.36,.39],
  'all-others':[.63,.61,.63,.60,.55,.52,.54,.54,.57,.54,.53,.56,.55,.54,.58,.56,.55,.55,.56],
});

const DEFAULT_SUBTYPE = Object.freeze({
  office:'automatic', retail:'standalone', school:'primary', warehouse:'nonrefrigerated',
  hotel:'automatic', multifamily:'residential', healthcare:'outpatient',
  restaurant:'full', 'all-others':'other', mixed:'mixed',
});

export const LEED_V5_BDC_DEFAULTS = Object.freeze({
  schema:'env-studio-leed-v5-bdc', version:2,
  ratingSystem:'bdc-new-construction', method:'appendix-g-energy-simulation',
  projectScope:'new-construction', ashraeEdition:'90.1-2019', registrationDate:'', modeler:'',
  buildingAreaType:'office', buildingSubtype:'automatic', hotelRooms:75,
  climateZone:'4A', projectLocation:'outside-us',
  mixedUseAreas:Object.freeze({}), heatingOnly:false, districtHeating:false, districtCooling:false,
  electricitySourceFactor:2, electricitySourceFactorSource:'', onSiteRenewableKWh:0,
  documentation:Object.freeze({
    mandatoryProvisions:'not-assessed', envelopeBackstop:'not-assessed',
    appendixGReview:'not-assessed', notes:'',
  }),
});

const IP_U_TO_SI = 5.678263;
const W_FT2_TO_W_M2 = 10.76391;
const FT2_TO_M2 = 0.09290304;

function clone(value) { return value == null ? value : JSON.parse(JSON.stringify(value)); }
function finiteOrNull(value) {
  if (value === '' || value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}
function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}
function round(value, digits = 4) {
  const factor = 10 ** digits;
  return Math.round((value + Number.EPSILON) * factor) / factor;
}
function evidenceValue(value) {
  return ['not-assessed','complies','does-not-comply','not-applicable'].includes(value)
    ? value : 'not-assessed';
}

export function normalizeLeedV5BdcSettings(raw = {}) {
  const buildingAreaType = Object.hasOwn(LEED_BUILDING_AREA_TYPES, raw.buildingAreaType)
    ? raw.buildingAreaType : LEED_V5_BDC_DEFAULTS.buildingAreaType;
  const subtypeOptions = LEED_BUILDING_SUBTYPES[buildingAreaType] || {};
  const buildingSubtype = Object.hasOwn(subtypeOptions, raw.buildingSubtype)
    ? raw.buildingSubtype : DEFAULT_SUBTYPE[buildingAreaType];
  const documentation = {
    ...clone(LEED_V5_BDC_DEFAULTS.documentation), ...(raw.documentation || {}),
  };
  documentation.mandatoryProvisions = evidenceValue(documentation.mandatoryProvisions);
  documentation.envelopeBackstop = evidenceValue(documentation.envelopeBackstop);
  documentation.appendixGReview = evidenceValue(documentation.appendixGReview);
  documentation.notes = String(documentation.notes || '');
  const mixedUseAreas = {};
  for (const type of Object.keys(BPF_2019)) {
    const area = Math.max(0, finiteOrNull(raw.mixedUseAreas?.[type]) ?? 0);
    if (area > 0) mixedUseAreas[type] = area;
  }
  const normalized = {
    ...clone(LEED_V5_BDC_DEFAULTS), ...raw,
    schema:'env-studio-leed-v5-bdc', version:2,
    ratingSystem:'bdc-new-construction', method:'appendix-g-energy-simulation',
    projectScope:'new-construction',
    ashraeEdition:Object.hasOwn(LEED_ASHRAE_EDITIONS, raw.ashraeEdition)
      ? raw.ashraeEdition : LEED_V5_BDC_DEFAULTS.ashraeEdition,
    registrationDate:String(raw.registrationDate || ''), modeler:String(raw.modeler || ''),
    buildingAreaType, buildingSubtype,
    hotelRooms:Math.max(1, Math.round(finiteOrNull(raw.hotelRooms) ?? 75)),
    climateZone:LEED_CLIMATE_ZONES.includes(raw.climateZone)
      ? raw.climateZone : LEED_V5_BDC_DEFAULTS.climateZone,
    projectLocation:['us','outside-us'].includes(raw.projectLocation) ? raw.projectLocation : 'outside-us',
    mixedUseAreas,
    heatingOnly:raw.heatingOnly === true,
    districtHeating:raw.districtHeating === true,
    districtCooling:raw.districtCooling === true,
    electricitySourceFactor:bounded(raw.electricitySourceFactor, 0.01, 20, 2),
    electricitySourceFactorSource:String(raw.electricitySourceFactorSource || ''),
    onSiteRenewableKWh:Math.max(0, finiteOrNull(raw.onSiteRenewableKWh) ?? 0),
    documentation,
  };
  // Drop version-1 manual baseline fields during migration. Keeping these in
  // saved project JSON would imply that they still control the generated
  // baseline when the version-2 rules engine deliberately ignores them.
  delete normalized.prerequisiteBpf;
  delete normalized.creditBpf;
  delete normalized.baselineInputsVerified;
  delete normalized.baseline;
  return normalized;
}

function wallArea(surface) {
  return Math.max(0, Number(surface?.width) || 0) * Math.max(0, Number(surface?.height) || 0)
    || Math.max(0, Number(surface?.area) || 0);
}
function openingArea(opening) {
  return Math.max(0, Number(opening?.width) || 0) * Math.max(0, Number(opening?.height) || 0);
}
function exteriorWalls(btm) {
  return (btm?.surfaces || []).filter(surface => surface.type === 'Wall' && surface.boundary === 'Outdoors');
}

export function summarizeLeedBuilding(btm = {}) {
  const zones = (btm.zones || []).filter(zone => Number(zone.height) > 0);
  const floorAreaM2 = zones.reduce((sum, zone) => sum + Math.max(0, Number(zone.floorArea) || 0), 0);
  const levels = new Set(zones.map(zone => zone.levelIdx ?? round(Number(zone.zBase) || 0, 3)));
  const walls = exteriorWalls(btm);
  const grossWallAreaM2 = walls.reduce((sum, surface) => sum + wallArea(surface), 0);
  const windowAreaM2 = walls.reduce((sum, surface) => sum + (surface.windows || [])
    .filter(opening => opening.subtype !== 'door' && !opening.isVoid)
    .reduce((subtotal, opening) => subtotal + openingArea(opening), 0), 0);
  const skylightAreaM2 = (btm.surfaces || []).reduce((sum, surface) => sum + (surface.skylights || [])
    .filter(opening => !opening.isVoid).reduce((subtotal, opening) => subtotal + openingArea(opening), 0), 0);
  return {
    conditionedZones:zones.length, floorAreaM2, stories:Math.max(1, levels.size),
    exteriorWallCount:walls.length, grossWallAreaM2, windowAreaM2, skylightAreaM2,
    proposedWwr:grossWallAreaM2 > 0 ? windowAreaM2 / grossWallAreaM2 : 0,
  };
}

function bpfForType(table, type, climateZone) {
  const row = table[type] || table['all-others'];
  return row[LEED_CLIMATE_ZONES.indexOf(climateZone)];
}

export function automaticLeedBpfs(settings = {}) {
  const s = normalizeLeedV5BdcSettings(settings);
  const tableValue = (table, type) => bpfForType(table, type, s.climateZone);
  let prerequisiteBpf;
  let creditBpf;
  let weighting = null;
  if (s.buildingAreaType === 'mixed') {
    const entries = Object.entries(s.mixedUseAreas).filter(([,area]) => area > 0);
    const total = entries.reduce((sum,[,area]) => sum + area, 0);
    if (total > 0) {
      const weighted = table => entries.reduce((sum,[type,area]) => sum + tableValue(table,type) * area, 0) / total;
      prerequisiteBpf = weighted(s.ashraeEdition === '90.1-2022' ? BPF_2022 : BPF_2019);
      creditBpf = weighted(BPF_2019);
      weighting = entries.map(([type,area]) => ({ type, areaM2:area, fraction:area / total }));
    }
  } else {
    prerequisiteBpf = tableValue(s.ashraeEdition === '90.1-2022' ? BPF_2022 : BPF_2019, s.buildingAreaType);
    creditBpf = tableValue(BPF_2019, s.buildingAreaType);
  }
  return {
    prerequisiteBpf:finiteOrNull(prerequisiteBpf) == null ? null : round(prerequisiteBpf, 4),
    creditBpf:finiteOrNull(creditBpf) == null ? null : round(creditBpf, 4),
    prerequisiteTable:s.ashraeEdition === '90.1-2022' ? '90.1-2022 future-source BPF' : '90.1-2019 future-source BPF',
    creditTable:'LEED v5 New Construction 90.1-2019-equivalent future-source BPF',
    weighting,
  };
}

function resolvedSubtype(settings, summary) {
  if (settings.buildingAreaType === 'office') {
    if (summary.floorAreaM2 <= 5000 * FT2_TO_M2) return 'office-small';
    if (summary.floorAreaM2 <= 50000 * FT2_TO_M2) return 'office-medium';
    return 'office-large';
  }
  if (settings.buildingAreaType === 'hotel') return settings.hotelRooms <= 75 ? 'hotel-small' : 'hotel-large';
  return settings.buildingSubtype;
}

function prescribedWwr(settings, summary, subtype) {
  const values = {
    grocery:.07, outpatient:.21, hospital:.27, 'hotel-small':.24, 'hotel-large':.34,
    'office-small':.19, 'office-medium':.31, 'office-large':.40,
    full:.24, quick:.34, standalone:.11, strip:.20, primary:.22, university:.22,
    nonrefrigerated:.06,
  };
  if (Object.hasOwn(values, subtype)) return { value:values[subtype], basis:'prescribed building-type WWR' };
  return { value:Math.min(summary.proposedWwr, .40), basis:'proposed WWR or 40%, whichever is less' };
}

function lpdFor(settings, subtype) {
  const ip = {
    office:1.0, retail:1.5, school:1.2, warehouse:.8, hotel:1.09,
    multifamily:.7, 'all-others':1.0,
  };
  let value = ip[settings.buildingAreaType] ?? 1.0;
  if (settings.buildingAreaType === 'healthcare') value = subtype === 'hospital' ? 1.2 : 1.0;
  if (settings.buildingAreaType === 'restaurant') value = subtype === 'quick' ? 1.4 : subtype === 'bar' ? 1.3 : 1.6;
  return { wPerFt2:value, wPerM2:round(value * W_FT2_TO_W_M2, 3) };
}

function windowIp(climateZone, residential, wwr) {
  const z = climateZone;
  if (!residential) {
    if (/^[012]/.test(z)) return [1.22,.25];
    if (z === '3A' || z === '3B') return wwr <= .10 ? [.57,.39] : [.57,.25];
    if (z === '3C') return wwr <= .10 ? [1.22,.61] : wwr <= .30 ? [1.22,.39] : [1.22,.34];
    if (z.startsWith('4')) return [.57,.39];
    if (z.startsWith('5') || z.startsWith('6')) return wwr <= .10 ? [.57,.49] : [.57,.39];
    if (z === '7') return [.57,.49];
    return [.46,.40];
  }
  if (z.startsWith('0') || z.startsWith('1')) return [1.22,.25];
  if (z.startsWith('2')) return wwr <= .10 ? [1.22,.39] : [1.22,.25];
  if (z === '3A' || z === '3B') return wwr <= .20 ? [.57,.39] : [.57,.25];
  if (z === '3C') return wwr <= .20 ? [1.22,.61] : wwr <= .30 ? [1.22,.39] : [1.22,.34];
  if (z.startsWith('4')) return [.57,.39];
  if (z.startsWith('5') || z.startsWith('6')) return wwr <= .10 ? [.57,.49] : [.57,.39];
  if (z === '7') return [.57,.49];
  return [.46,.40];
}

function envelope2019(settings, wwr) {
  if (settings.ashraeEdition !== '90.1-2019') return null;
  const residential = settings.buildingAreaType === 'multifamily';
  const z = settings.climateZone;
  let wallIp, roofIp, floorIp;
  if (!residential) {
    wallIp = /^[01234]/.test(z) ? .124 : /^[56]/.test(z) ? .084 : .064;
    roofIp = z === '8' ? .048 : .063;
    floorIp = /^[01]/.test(z) ? .35 : z.startsWith('6') || z === '7' || z === '8' ? .038 : .052;
  } else {
    wallIp = /^[012]/.test(z) ? .124 : z.startsWith('3') ? .084 : z === '8' ? .055 : .064;
    roofIp = z === '8' ? .048 : .063;
    floorIp = /^[01]/.test(z) ? .35 : z.startsWith('3') || z.startsWith('2') ? .052 : z === '8' ? .032 : .038;
  }
  const [windowUIp, windowShgc] = windowIp(z, residential, wwr);
  return {
    category:residential ? 'residential' : 'nonresidential',
    wallU:round(wallIp * IP_U_TO_SI), roofU:round(roofIp * IP_U_TO_SI),
    floorU:round(floorIp * IP_U_TO_SI), windowU:round(windowUIp * IP_U_TO_SI),
    windowShgc,
  };
}

function baselineHvac(settings, summary, subtype) {
  const areaFt2 = summary.floorAreaM2 / FT2_TO_M2;
  const stories = summary.stories;
  let number, name;
  if (settings.buildingAreaType === 'multifamily') [number,name] = [1,'PTAC / PTHP'];
  else if (settings.heatingOnly && settings.buildingAreaType === 'warehouse') [number,name] = [9,'Heating and ventilation'];
  else if (subtype === 'public-assembly' && areaFt2 >= 120000) [number,name] = [12,'Single-zone constant volume'];
  else if (stories <= 3 && areaFt2 < 25000) [number,name] = [3,'Packaged single-zone AC / heat pump'];
  else if (stories <= 5 && areaFt2 <= 150000) [number,name] = [5,'Packaged VAV with reheat'];
  else [number,name] = [7,'VAV with reheat'];
  const electricClimate = ['0A','1A','2A','3A'].includes(settings.climateZone);
  const heatingSource = subtype === 'hospital' ? 'fossil fuel' : electricClimate ? 'electric' : 'fossil fuel';
  return { systemNumber:number, systemName:name, heatingSource };
}

export function deriveLeedV5Automation(btm = {}, rawSettings = {}) {
  const settings = normalizeLeedV5BdcSettings(rawSettings);
  const summary = summarizeLeedBuilding(btm);
  const subtype = resolvedSubtype(settings, summary);
  const wwr = prescribedWwr(settings, summary, subtype);
  const bpfs = automaticLeedBpfs(settings);
  const envelope = envelope2019(settings, wwr.value);
  const lighting = lpdFor(settings, subtype);
  const hvac = baselineHvac(settings, summary, subtype);
  const runBlockers = [];
  const submissionBlockers = [];
  if (!summary.conditionedZones) runBlockers.push('The model has no conditioned zones.');
  if (!(summary.floorAreaM2 > 0)) runBlockers.push('Conditioned floor area must be greater than zero.');
  if (!(summary.grossWallAreaM2 > 0)) runBlockers.push('No exterior wall area is available for the Appendix G fenestration baseline.');
  if (settings.buildingAreaType === 'mixed' && !bpfs.weighting?.length) {
    runBlockers.push('Enter floor area for each mixed-use building type so the BPF can be area weighted.');
  }
  if (!envelope) {
    runBlockers.push('90.1-2022 BPFs are automated, but the 2022 Appendix G envelope/system construction dataset is not yet implemented. Select 90.1-2019 only when the LEED registration date permits it.');
  }
  if (settings.districtHeating || settings.districtCooling) {
    submissionBlockers.push('District energy requires the applicable LEED district-energy treatment and a detailed plant model.');
  }
  if (summary.skylightAreaM2 > 0) {
    submissionBlockers.push('Skylight area, U-factor and SHGC rules require a separate Appendix G roof-fenestration implementation.');
  }
  if (settings.buildingAreaType === 'mixed') {
    submissionBlockers.push('Mixed-use envelope, lighting and HVAC rules must be assigned by space/building area; this screen uses area-weighted BPFs only.');
  }
  submissionBlockers.push(
    'The current simulation uses Ideal Loads with fixed COP/fan-pump conversion; the derived Appendix G HVAC system is reported but not yet instantiated.',
    'Service water heating, ventilation, economizers, heat recovery, fan power, pump power and equipment efficiency rules are not represented by the current BTM.',
    'Lighting control schedule adjustments, daylight controls, receptacle controls and process-load exceptional calculations require space-level inputs.',
    'Authored shading is copied to all rotations because the model does not yet distinguish surrounding context, self-shading and proposed-only shading devices.',
    'Unmet-load-hour equivalence, sizing runs, plant autosizing and Appendix G output QA remain required for a submission model.',
  );
  const rules = [
    { id:'leed-bpf-prerequisite', clause:'LEED v5 EAp2 / 90.1 Appendix G', status:'automated',
      decision:`EAp2 BPF ${bpfs.prerequisiteBpf ?? '—'} from ${bpfs.prerequisiteTable}.`, source:'doeBpfCalculator' },
    { id:'leed-bpf-credit', clause:'LEED v5 EAc3 New Construction', status:'automated',
      decision:`EAc3 BPF ${bpfs.creditBpf ?? '—'} from ${bpfs.creditTable}.`, source:'ratingSystem' },
    { id:'g3-wwr', clause:'90.1-2019 G3.1.1 / Table G3.1.1-1', status:'automated',
      decision:`Baseline WWR ${(wwr.value * 100).toFixed(1)}% (${wwr.basis}); proposed ${(summary.proposedWwr * 100).toFixed(1)}%.`, source:'openstudioStandards' },
    { id:'g3-envelope', clause:'90.1-2019 Table G3.4', status:envelope ? 'automated' : 'blocked',
      decision:envelope ? `${envelope.category} envelope for climate zone ${settings.climateZone}.` : '2022 construction dataset is not available.', source:'openstudioStandards' },
    { id:'g3-lighting', clause:'90.1-2019 Table G3.7 / Section 9.5', status:'automated',
      decision:`Whole-building LPD ${lighting.wPerFt2.toFixed(2)} W/ft² (${lighting.wPerM2.toFixed(2)} W/m²).`, source:'openstudioStandards' },
    { id:'g3-hvac', clause:'90.1-2019 Tables G3.1.1-3 and G3.1.1-4', status:'derived-not-simulated',
      decision:`Baseline System ${hvac.systemNumber}: ${hvac.systemName}; ${hvac.heatingSource} heat.`, source:'openstudioStandards' },
    { id:'g3-rotations', clause:'90.1 Appendix G baseline rotations', status:'automated',
      decision:'Baseline simulations at 0°, 90°, 180° and 270°; annual results are averaged.', source:'doePrmManual' },
    { id:'g3-schedules-loads', clause:'90.1 Table G3.1', status:'copied-with-qa',
      decision:'Proposed schedules, occupancy and receptacle loads are copied to the baseline.', source:'doePrmManual' },
    { id:'g3-shading', clause:'90.1 Table G3.1', status:'copied-with-qa',
      decision:'All authored shading polygons are copied to every baseline rotation pending shade classification.', source:'doePrmManual' },
  ];
  return {
    settings, summary, subtype, bpfs, wwr, envelope, lighting, hvac,
    rotations:[0,90,180,270], baselineServices:{ heatingCOP:3, coolingCOP:3, fanPumpAllowancePct:10 },
    runBlockers:[...new Set(runBlockers)], submissionBlockers:[...new Set(submissionBlockers)], rules,
    screeningOnly:true, submissionReady:false,
  };
}

export function validateLeedV5BdcRun(settings = {}, zones = [], btm = null) {
  const fallbackBtm = btm || { zones };
  const automation = deriveLeedV5Automation(fallbackBtm, settings);
  const errors = [...automation.runBlockers];
  const warnings = [];
  const s = automation.settings;
  if (s.projectLocation === 'outside-us' && s.electricitySourceFactor < 2
    && !s.electricitySourceFactorSource.trim()) {
    errors.push('Cite the national-average source for an electricity conversion factor below 2.0.');
  }
  if (!s.registrationDate) warnings.push('Record the LEED registration date to confirm the permitted ASHRAE 90.1 edition and addenda.');
  if (!s.modeler.trim()) warnings.push('Record the energy modeler for the LEED simulation report.');
  if (s.documentation.mandatoryProvisions !== 'complies') warnings.push('Mandatory provisions compliance is not confirmed.');
  if (s.documentation.envelopeBackstop !== 'complies') warnings.push('The Section 5.5/5.6 envelope backstop is not confirmed.');
  if (s.documentation.appendixGReview !== 'complies') warnings.push('The full Appendix G input and output review is not complete.');
  warnings.push(...automation.submissionBlockers);
  return { settings:s, automation, errors:[...new Set(errors)], warnings:[...new Set(warnings)], valid:errors.length === 0 };
}

function generatedWindow(surface, desiredArea, index) {
  const hostWidth = Math.max(0, Number(surface.width) || 0);
  const hostHeight = Math.max(0, Number(surface.height) || 0);
  if (!(hostWidth > 0 && hostHeight > 0 && desiredArea > 0)) return null;
  const margin = .04;
  const maxWidth = hostWidth * (1 - margin * 2);
  const maxHeight = hostHeight * (1 - margin * 2);
  let width = Math.min(maxWidth, Math.max(hostWidth * .25, Math.sqrt(desiredArea * (hostWidth / hostHeight))));
  let height = desiredArea / width;
  if (height > maxHeight) { height = maxHeight; width = Math.min(maxWidth, desiredArea / height); }
  const achieved = width * height;
  const dx = (Number(surface.p2?.x) || 0) - (Number(surface.p1?.x) || 0);
  const dy = (Number(surface.p2?.y) || 0) - (Number(surface.p1?.y) || 0);
  const length = Math.hypot(dx,dy) || hostWidth;
  const ux = dx / length, uy = dy / length;
  const start = (hostWidth - width) / 2;
  const x1 = (Number(surface.p1?.x) || 0) + ux * start;
  const y1 = (Number(surface.p1?.y) || 0) + uy * start;
  return {
    id:`leed-baseline-window-${surface.id || index}`,
    subtype:'window', x1, y1, x2:x1 + ux * width, y2:y1 + uy * width,
    z0:(Number(surface.zBase) || 0) + (hostHeight - height) / 2,
    width, height, area:achieved,
  };
}

/** Create a detached baseline, including prescribed WWR and glazing values. */
export function createLeedAutomatedBaselineBtm(btm = {}, settings = {}, suppliedAutomation = null) {
  const automation = suppliedAutomation || deriveLeedV5Automation(btm, settings);
  if (!automation.envelope) throw new Error('The selected edition has no automated baseline envelope dataset.');
  const out = clone(btm) || {};
  const envelopeKeys = ['extWall','roof','exposedFloor','groundFloor','window'];
  for (const zone of out.zones || []) {
    zone.constructions = { ...(zone.constructions || {}) };
    for (const key of envelopeKeys) delete zone.constructions[key];
    zone.energyProps = { ...(zone.energyProps || {}), lightingPowerDensity:automation.lighting.wPerM2 };
  }
  const walls = exteriorWalls(out);
  const gross = walls.reduce((sum, surface) => sum + wallArea(surface), 0);
  const existingTotal = walls.reduce((sum, surface) => sum + (surface.windows || [])
    .filter(opening => opening.subtype !== 'door' && !opening.isVoid)
    .reduce((subtotal, opening) => subtotal + openingArea(opening), 0), 0);
  const targetTotal = gross * automation.wwr.value;
  walls.forEach((surface, index) => {
    const doorsAndVoids = (surface.windows || []).filter(opening => opening.subtype === 'door' || opening.isVoid);
    const existing = (surface.windows || []).filter(opening => opening.subtype !== 'door' && !opening.isVoid)
      .reduce((sum, opening) => sum + openingArea(opening), 0);
    const share = existingTotal > 0 ? existing / existingTotal : gross > 0 ? wallArea(surface) / gross : 0;
    const window = generatedWindow(surface, targetTotal * share, index);
    if (window) {
      window.energyOverrides = { uValue:true, shgc:true };
      window.uValue = automation.envelope.windowU;
      window.shgc = automation.envelope.windowShgc;
    }
    surface.windows = [...doorsAndVoids, ...(window ? [window] : [])];
  });
  return out;
}

// Backward-compatible alias used by older saved browser sessions.
export const createLeedPreliminaryBaselineBtm = createLeedAutomatedBaselineBtm;

export function leedAutomatedBaselineConstructions(settings = {}, btm = {}) {
  const automation = deriveLeedV5Automation(btm, settings);
  if (!automation.envelope) return {};
  return {
    extWall:{ uValue:automation.envelope.wallU }, roof:{ uValue:automation.envelope.roofU },
    exposedFloor:{ uValue:automation.envelope.floorU }, groundFloor:{ uValue:automation.envelope.floorU },
  };
}
export const leedPreliminaryBaselineConstructions = leedAutomatedBaselineConstructions;

function averageNumeric(values) {
  const finite = values.map(Number).filter(Number.isFinite);
  return finite.length ? finite.reduce((sum,value) => sum + value, 0) / finite.length : null;
}

export function averageLeedBaselineRuns(runs = []) {
  if (!runs.length) throw new Error('No baseline rotations were supplied.');
  const streamNames = [...new Set(runs.flatMap(run => Object.keys(run?.metrics?.streams || {})))];
  const streams = {};
  for (const name of streamNames) {
    const samples = runs.map(run => run?.metrics?.streams?.[name]).filter(Boolean);
    const zoneKeys = [...new Set(samples.flatMap(sample => Object.keys(sample.byZone || {})))];
    streams[name] = {
      kWh:averageNumeric(samples.map(sample => sample.kWh)),
      kWhPerM2:averageNumeric(samples.map(sample => sample.kWhPerM2)),
      byZone:Object.fromEntries(zoneKeys.map(key => [key, {
        displayName:samples.find(sample => sample.byZone?.[key])?.byZone[key].displayName || key,
        kWh:averageNumeric(samples.map(sample => sample.byZone?.[key]?.kWh)),
        kWhPerM2:averageNumeric(samples.map(sample => sample.byZone?.[key]?.kWhPerM2)),
      }])),
    };
  }
  return { ok:runs.every(run => run?.ok), metrics:{ streams }, rotations:runs };
}

export function leedElectricSiteBreakdown(streams = {}, services = {}) {
  const positive = value => Math.max(0, Number(value) || 0);
  const heatingCOP = Math.max(0.1, Number(services.heatingCOP) || 3);
  const coolingCOP = Math.max(0.1, Number(services.coolingCOP) || 3);
  const heating = positive(streams.heating?.kWh ?? streams.heatingKWh) / heatingCOP;
  const cooling = positive(streams.cooling?.kWh ?? streams.coolingKWh) / coolingCOP;
  const lights = positive(streams.lights?.kWh ?? streams.lightingKWh);
  const equipment = positive(streams.equipment?.kWh ?? streams.equipmentKWh);
  const reportedFanPump = ['fans','pumps'].reduce((sum, key) =>
    sum + (Number.isFinite(Number(streams[key]?.kWh)) ? positive(streams[key].kWh) : 0), 0);
  const hasReportedFanPump = ['fans','pumps'].some(key => Number.isFinite(Number(streams[key]?.kWh)));
  const fanPump = hasReportedFanPump ? reportedFanPump
    : (heating + cooling) * bounded(services.fanPumpAllowancePct, 0, 100, 10) / 100;
  const regulated = heating + cooling + lights + fanPump;
  const unregulated = equipment;
  return { heating, cooling, lights, equipment, fanPump, regulated, unregulated, total:regulated + unregulated };
}

function pointsForReduction(reductionPercent, thresholds) {
  let points = 0;
  thresholds.forEach((threshold, index) => { if (reductionPercent + 1e-9 >= threshold) points = index + 1; });
  return points;
}

export function calculateLeedV5Performance({ proposed, baseline } = {}, settings = {}) {
  const normalized = normalizeLeedV5BdcSettings(settings);
  const bpfs = automaticLeedBpfs(normalized);
  if (!(bpfs.prerequisiteBpf > 0 && bpfs.creditBpf > 0)) throw new Error('Automatic LEED BPFs could not be resolved.');
  const proposedSite = leedElectricSiteBreakdown(proposed?.metrics?.streams, proposed?.services || {});
  const baselineServices = baseline?.services || { heatingCOP:3, coolingCOP:3, fanPumpAllowancePct:10 };
  const baselineSite = leedElectricSiteBreakdown(baseline?.metrics?.streams, baselineServices);
  const factor = normalized.electricitySourceFactor;
  const BBRE = baselineSite.regulated * factor;
  const BBUE = baselineSite.unregulated * factor;
  const BBP = BBRE + BBUE;
  const PBPnre = proposedSite.total * factor;
  const renewableFutureSource = Math.min(PBPnre, normalized.onSiteRenewableKWh * factor);
  const PBP = Math.max(0, PBPnre - renewableFutureSource);
  if (!(BBP > 0)) throw new Error('The averaged baseline simulations returned no annual energy.');
  const PInre = PBPnre / BBP;
  const PI = PBP / BBP;
  const target = bpf => (BBUE + bpf * BBRE) / BBP;
  const prerequisitePIt = target(bpfs.prerequisiteBpf);
  const creditPIt = target(bpfs.creditBpf);
  const excludingRenewablesPercent = (1 - PInre / creditPIt) * 100;
  const includingRenewablesPercent = (1 - PI / creditPIt) * 100;
  const excludingRenewablesPoints = pointsForReduction(excludingRenewablesPercent, LEED_V5_POINT_THRESHOLDS.excludingRenewables);
  const includingRenewablesPoints = pointsForReduction(includingRenewablesPercent, LEED_V5_POINT_THRESHOLDS.includingRenewables);
  const prerequisitePass = PInre <= prerequisitePIt + 1e-9;
  const bestPath = includingRenewablesPoints > excludingRenewablesPoints ? 'including-renewables' : 'excluding-renewables';
  const potentialPoints = Math.max(excludingRenewablesPoints, includingRenewablesPoints);
  return {
    method:'LEED v5 BD+C New Construction · Appendix G future source energy', bpfs,
    proposedSite, baselineSite, futureSource:{ BBRE, BBUE, BBP, PBPnre, PBP, renewableFutureSource },
    indices:{ PInre, PI, prerequisitePIt, creditPIt },
    prerequisite:{ pass:prerequisitePass, metric:'PInre', value:PInre, target:prerequisitePIt },
    credit:{ excludingRenewablesPercent, includingRenewablesPercent,
      excludingRenewablesPoints, includingRenewablesPoints, bestPath, potentialPoints,
      estimatedPoints:prerequisitePass ? potentialPoints : 0 },
    screeningOnly:true, certificationStatus:'not-submission-ready',
    limitations:[
      'This result is an early-design screen, not a LEED certification determination.',
      'The baseline envelope, WWR, whole-building lighting and rotations are automated; detailed Appendix G HVAC and plant are not yet simulated.',
      'Only modeled heating, cooling, fan/pump allowance, interior lighting and electric equipment are included in the PI split.',
    ],
  };
}
