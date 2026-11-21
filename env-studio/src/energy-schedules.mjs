// Editable EnergyPlus fraction schedules used by the Energy settings UI.
//
// The use-type presets are compact, normalized adaptations of the occupancy,
// lighting, plug-load, and HVAC patterns published with DOE/PNNL's ASHRAE
// Standard 90.1 prototype building models:
// https://www.energycodes.gov/prototype-building-models

export const ENERGY_SCHEDULE_KEYS = Object.freeze([
  'hvac', 'occupancy', 'lighting', 'equipment',
]);

export const ENERGY_SCHEDULE_LABELS = Object.freeze({
  hvac: 'HVAC',
  occupancy: 'Occupancy',
  lighting: 'Lighting',
  equipment: 'Equipment',
});

function hourly(base, bands = []) {
  const values = Array(24).fill(base);
  for (const [start, end, value] of bands) {
    for (let hour = Math.max(0, start); hour < Math.min(24, end); hour++) values[hour] = value;
  }
  return Object.freeze(values);
}

function freezeProfile(weekday, saturday = weekday, sunday = saturday) {
  return Object.freeze({ weekday, saturday, sunday });
}

const ALWAYS = hourly(1);

export const ENERGY_SCHEDULE_PRESETS = Object.freeze({
  always: Object.freeze({
    label: '24/7',
    description: 'Full operation every hour of the week.',
    profiles: Object.freeze({
      hvac: freezeProfile(ALWAYS), occupancy: freezeProfile(ALWAYS),
      lighting: freezeProfile(ALWAYS), equipment: freezeProfile(ALWAYS),
    }),
  }),
  school: Object.freeze({
    label: 'School schedule',
    description: 'ASHRAE 90.1 school prototype pattern with weekday teaching hours and reduced weekends.',
    profiles: Object.freeze({
      hvac: freezeProfile(hourly(0, [[6, 18, 1]]), hourly(0, [[7, 14, 1]]), hourly(0)),
      occupancy: freezeProfile(hourly(0, [[7, 8, 0.1], [8, 15, 1], [15, 17, 0.2]]), hourly(0, [[8, 14, 0.05]]), hourly(0)),
      lighting: freezeProfile(hourly(0.1, [[7, 17, 1]]), hourly(0.1, [[8, 14, 0.2]]), hourly(0.1)),
      equipment: freezeProfile(hourly(0.25, [[7, 17, 1]]), hourly(0.25, [[8, 14, 0.4]]), hourly(0.25)),
    }),
  }),
  office: Object.freeze({
    label: '9 to 5 work schedule',
    description: 'ASHRAE 90.1 office prototype pattern centered on weekday working hours.',
    profiles: Object.freeze({
      hvac: freezeProfile(hourly(0, [[6, 19, 1]]), hourly(0, [[7, 17, 1]]), hourly(0)),
      occupancy: freezeProfile(hourly(0.05, [[9, 17, 1]]), hourly(0.05, [[9, 13, 0.15]]), hourly(0.05)),
      lighting: freezeProfile(hourly(0.1, [[8, 18, 1]]), hourly(0.1, [[8, 14, 0.3]]), hourly(0.1)),
      equipment: freezeProfile(hourly(0.3, [[8, 18, 1]]), hourly(0.3, [[9, 14, 0.5]]), hourly(0.3)),
    }),
  }),
  residential: Object.freeze({
    label: 'Residential schedule',
    description: 'ASHRAE 90.1 apartment prototype pattern with morning and evening peaks.',
    profiles: Object.freeze({
      hvac: freezeProfile(ALWAYS),
      occupancy: freezeProfile(
        hourly(0.25, [[0, 7, 1], [7, 9, 0.65], [17, 22, 0.8], [22, 24, 1]]),
        hourly(0.65, [[0, 8, 1], [18, 24, 0.9]]),
        hourly(0.75, [[0, 9, 1], [18, 24, 0.95]])),
      lighting: freezeProfile(
        hourly(0.1, [[0, 6, 0.2], [6, 8, 0.45], [17, 23, 0.75], [23, 24, 0.25]]),
        hourly(0.15, [[7, 10, 0.35], [17, 23, 0.75], [23, 24, 0.25]]),
        hourly(0.15, [[7, 10, 0.35], [17, 23, 0.75], [23, 24, 0.25]])),
      equipment: freezeProfile(
        hourly(0.25, [[6, 9, 0.45], [17, 23, 0.65], [23, 24, 0.35]]),
        hourly(0.35, [[8, 11, 0.5], [17, 23, 0.65]]),
        hourly(0.35, [[8, 11, 0.5], [17, 23, 0.65]])),
    }),
  }),
});

export const DEFAULT_ENERGY_SCHEDULES = Object.freeze({
  hvac: Object.freeze({ preset: 'always' }),
  occupancy: Object.freeze({ preset: 'office' }),
  lighting: Object.freeze({ preset: 'office' }),
  equipment: Object.freeze({ preset: 'office' }),
});

function cloneHours(values, fallback) {
  return Array.from({ length: 24 }, (_, hour) => {
    const value = Number(values?.[hour]);
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : fallback[hour];
  });
}

export function resolveEnergySchedule(spec, key) {
  const fallbackPreset = DEFAULT_ENERGY_SCHEDULES[key]?.preset || 'office';
  const presetKey = Object.hasOwn(ENERGY_SCHEDULE_PRESETS, spec?.preset) ? spec.preset : fallbackPreset;
  const preset = ENERGY_SCHEDULE_PRESETS[presetKey].profiles[key];
  if (spec?.preset !== 'custom') {
    return {
      preset: presetKey,
      name: ENERGY_SCHEDULE_PRESETS[presetKey].label,
      weekday: [...preset.weekday], saturday: [...preset.saturday], sunday: [...preset.sunday],
    };
  }
  return {
    preset: 'custom',
    name: String(spec.name || `Custom ${ENERGY_SCHEDULE_LABELS[key] || key}`).slice(0, 80),
    weekday: cloneHours(spec.weekday, preset.weekday),
    saturday: cloneHours(spec.saturday, preset.saturday),
    sunday: cloneHours(spec.sunday, preset.sunday),
  };
}

export function normalizeEnergyScheduleSpec(spec, key) {
  const resolved = resolveEnergySchedule(spec, key);
  return resolved.preset === 'custom' ? resolved : { preset: resolved.preset };
}

export function normalizeEnergySchedules(raw = {}) {
  return Object.fromEntries(ENERGY_SCHEDULE_KEYS.map(key => [
    key, normalizeEnergyScheduleSpec(raw?.[key] || DEFAULT_ENERGY_SCHEDULES[key], key),
  ]));
}

function compactDayFields(label, values) {
  const fields = [`For: ${label}`];
  for (let hour = 0; hour < 24; hour++) {
    if (hour < 23 && values[hour + 1] === values[hour]) continue;
    fields.push(`Until: ${String(hour + 1).padStart(2, '0')}:00`, values[hour]);
  }
  return fields;
}

export function energyScheduleCompactFields(spec, key) {
  const resolved = resolveEnergySchedule(spec, key);
  return [
    'Through: 12/31',
    ...compactDayFields('Weekdays', resolved.weekday),
    ...compactDayFields('Saturday', resolved.saturday),
    ...compactDayFields('AllOtherDays', resolved.sunday),
  ];
}
