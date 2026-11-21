/**
 * Parse and summarize the hourly wind fields in an EnergyPlus EPW file.
 * EPW CSV columns are zero-based here: month=1, day=2, wind direction=20,
 * wind speed=21. Direction is degrees clockwise from north; speed is m/s.
 */

const DIRECTION_SECTORS = 16;
const SECTOR_WIDTH = 360 / DIRECTION_SECTORS;

function decodeText(input) {
  if (typeof input === 'string') return input;
  if (input instanceof ArrayBuffer) return new TextDecoder().decode(new Uint8Array(input));
  if (ArrayBuffer.isView(input)) {
    return new TextDecoder().decode(new Uint8Array(input.buffer, input.byteOffset, input.byteLength));
  }
  throw new TypeError('EPW wind data must be text, an ArrayBuffer, or a typed array');
}

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseEpwWindData(input) {
  const text = decodeText(input);
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/);
  const locationFields = (lines.find(line => /^LOCATION,/i.test(line.trim())) || '').split(',');
  const latitude = finiteNumber(locationFields[6]);
  const records = [];

  for (const line of lines) {
    if (!/^\s*\d{4},/.test(line)) continue;
    const fields = line.split(',');
    if (fields.length < 22) continue;
    const year = finiteNumber(fields[0]);
    const month = finiteNumber(fields[1]);
    const day = finiteNumber(fields[2]);
    const hour = finiteNumber(fields[3]);
    const minute = finiteNumber(fields[4]);
    const rawDirection = finiteNumber(fields[20]);
    const speed = finiteNumber(fields[21]);
    if (!Number.isInteger(month) || month < 1 || month > 12 ||
        !Number.isInteger(day) || day < 1 || day > 31 ||
        rawDirection === null || rawDirection < 0 || rawDirection > 360 || rawDirection === 999 ||
        speed === null || speed < 0 || speed > 40 || speed === 999) continue;
    records.push({
      year, month, day, hour, minute,
      direction: rawDirection === 360 ? 0 : rawDirection,
      speed,
    });
  }

  if (!records.length) {
    throw new Error('No valid EPW wind records were found. Wind analysis requires a full .epw file.');
  }

  return {
    records,
    latitude,
    location: locationFields[1]?.trim() || null,
  };
}

function seasonMonths(season, southernHemisphere) {
  const north = {
    winter: [12, 1, 2],
    spring: [3, 4, 5],
    summer: [6, 7, 8],
    autumn: [9, 10, 11],
  };
  const south = {
    summer: north.winter,
    autumn: north.spring,
    winter: north.summer,
    spring: north.autumn,
  };
  return (southernHemisphere ? south : north)[season] || null;
}

function parseMonthDay(value) {
  const match = /^(?:\d{4}-)?(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!match) return null;
  const month = +match[1], day = +match[2];
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  return { month, day };
}

function circularMeanDirection(records) {
  let x = 0, y = 0;
  for (const record of records) {
    const radians = record.direction * Math.PI / 180;
    x += Math.sin(radians);
    y += Math.cos(radians);
  }
  return (Math.atan2(x, y) * 180 / Math.PI + 360) % 360;
}

function selectWindiestDay(records) {
  const days = new Map();
  for (const record of records) {
    const key = `${String(record.month).padStart(2, '0')}-${String(record.day).padStart(2, '0')}`;
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(record);
  }
  const maxSamples = Math.max(...[...days.values()].map(day => day.length));
  // Prevent a day with only one or two unusually fast valid records from
  // beating complete days when the EPW contains missing wind observations.
  const minimumSamples = Math.max(1, Math.ceil(maxSamples * 0.75));
  let best = null;
  for (const [key, dayRecords] of days) {
    if (dayRecords.length < minimumSamples) continue;
    const meanSpeed = dayRecords.reduce((sum, record) => sum + record.speed, 0) / dayRecords.length;
    if (!best || meanSpeed > best.meanSpeed) best = { key, records:dayRecords, meanSpeed };
  }
  if (!best) return null;
  const [month, day] = best.key.split('-').map(Number);
  return { records:best.records, meanSpeed:best.meanSpeed, date:{ month, day } };
}

/**
 * Return the prevailing wind for an annual, seasonal, or month/day slice.
 * The dominant direction is the most frequent of 16 compass sectors. The
 * representative speed is the arithmetic mean within that dominant sector.
 */
export function derivePrevailingWind(dataset, options = {}) {
  if (!dataset?.records?.length) throw new Error('No parsed EPW wind records are available.');
  const period = options.period || 'annual';
  let selected = dataset.records;
  let months = null;
  let selectedDate = null;
  let dailyMeanSpeed = null;

  if (period === 'season') {
    const season = String(options.season || 'summer').toLowerCase();
    const southernHemisphere = Number.isFinite(dataset.latitude) && dataset.latitude < 0;
    months = seasonMonths(season, southernHemisphere);
    if (!months) throw new Error(`Unknown season: ${season}`);
    selected = selected.filter(record => months.includes(record.month));
  } else if (period === 'day') {
    const date = parseMonthDay(options.date || '06-21');
    if (!date) throw new Error('Choose a valid calendar day.');
    selectedDate = date;
    selected = selected.filter(record => record.month === date.month && record.day === date.day);
  } else if (period === 'windiest-day') {
    const windiest = selectWindiestDay(selected);
    if (!windiest) throw new Error('No sufficiently complete day has valid wind records in this EPW file.');
    selected = windiest.records;
    selectedDate = windiest.date;
    dailyMeanSpeed = windiest.meanSpeed;
  } else if (period !== 'annual') {
    throw new Error(`Unknown wind period: ${period}`);
  }

  if (!selected.length) throw new Error('The selected period has no valid wind records in this EPW file.');

  // EPW defines direction=0 for calm records. Exclude zero-speed samples from
  // the directional frequency calculation so calm hours are not misread as
  // northerly wind. If every selected record is calm, return a calm result.
  const directional = selected.filter(record => record.speed > 0);
  if (!directional.length) {
    return {
      direction: 0, speed: 0, frequency: 1,
      dominantCount: selected.length, directionalCount: 0,
      sampleCount: selected.length, calmCount: selected.length,
      sector: 0, sectorWidth: SECTOR_WIDTH, months, selectedDate, dailyMeanSpeed,
    };
  }

  const sectors = Array.from({ length: DIRECTION_SECTORS }, () => []);
  for (const record of directional) {
    const sector = Math.floor((record.direction + SECTOR_WIDTH / 2) / SECTOR_WIDTH) % DIRECTION_SECTORS;
    sectors[sector].push(record);
  }
  let dominantSector = 0;
  for (let sector = 1; sector < sectors.length; sector++) {
    if (sectors[sector].length > sectors[dominantSector].length) dominantSector = sector;
  }

  const dominant = sectors[dominantSector];
  const direction = circularMeanDirection(dominant);
  const speed = dominant.reduce((sum, record) => sum + record.speed, 0) / dominant.length;
  return {
    direction,
    speed,
    frequency: dominant.length / directional.length,
    dominantCount: dominant.length,
    directionalCount: directional.length,
    sampleCount: selected.length,
    calmCount: selected.length - directional.length,
    sector: dominantSector,
    sectorWidth: SECTOR_WIDTH,
    months,
    selectedDate,
    dailyMeanSpeed,
  };
}

export function epwSeasonMonths(season, latitude = 0) {
  return seasonMonths(String(season || '').toLowerCase(), Number.isFinite(latitude) && latitude < 0);
}
