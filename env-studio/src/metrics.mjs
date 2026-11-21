/**
 * IES LM-83-12 CBDM metric calculations: sDA, ASE, and UDI.
 *
 * Occupancy schedule (LM-83 default):
 *   8am–6pm daily = hours 8–17 inclusive (WEA hour indices 0-based, midpoint convention).
 *   365 days × 10 hours = 3,650 occupied hours per year.
 *
 * WEA hour convention: WEA data has one row per hour with midpoint times 0.5, 1.5, ..., 23.5.
 * In the 8760-element array, index t corresponds to hour midpoint (t % 24) + 0.5.
 * Occupied when (t % 24) ∈ {8, 9, 10, 11, 12, 13, 14, 15, 16, 17}.
 *
 * sDA₃₀₀/₅₀% (Spatial Daylight Autonomy):
 *   Fraction of sensors with E_lux ≥ 300 lux for ≥ 50% of occupied hours.
 *   Threshold: 300 lux, fraction: ≥ 50% (≥ 1,825 of 3,650 occupied hours).
 *
 * ASE₁₀₀₀,₂₅₀ (Annual Sunlight Exposure):
 *   Fraction of sensors with direct-sun illuminance ≥ 1,000 lux for > 250 occupied hours.
 *   CRITICAL: computed from DIRECT-SUNLIGHT-ONLY illuminance matrix (separate pipeline):
 *     - gendaymtx -m 1 -d    (direct sun patch only, no diffuse sky)
 *     - rcontrib -ab 0        (direct ray tracing, no interreflection)
 *   Using the full sDA illuminance matrix for ASE is WRONG (includes diffuse and bounced light).
 */

/** LM-83 default occupancy: 8am–6pm, all days. */
export const LM83_OCC_START = 8;   // first occupied hour index (0-based)
export const LM83_OCC_END   = 17;  // last occupied hour index (0-based)
export const LM83_HOURS_PER_DAY = LM83_OCC_END - LM83_OCC_START + 1;  // 10
export const LM83_OCCUPIED_HOURS = 365 * LM83_HOURS_PER_DAY;           // 3,650

/**
 * Build an 8760-element boolean mask: true for occupied hours.
 * @param {number} [start=8]   First occupied hour-of-day (0-based, WEA midpoint convention).
 * @param {number} [end=17]    Last occupied hour-of-day (inclusive).
 */
export function buildOccupancyMask(start = LM83_OCC_START, end = LM83_OCC_END) {
  const mask = new Uint8Array(8760);
  for (let t = 0; t < 8760; t++) {
    const h = t % 24;
    mask[t] = (h >= start && h <= end) ? 1 : 0;
  }
  return mask;
}

/**
 * Compute sDA₃₀₀/₅₀%: the fraction of sensors that receive ≥ 300 lux
 * for at least 50% of occupied hours.
 *
 * @param {{ nSensors, nHours, data: Float64Array }} luxMatrix
 *   Full annual illuminance matrix (direct + diffuse + interreflection).
 * @param {object} [opts]
 * @param {number} [opts.luxThreshold=300]   Minimum illuminance [lux].
 * @param {number} [opts.fraction=0.5]       Minimum fraction of occupied hours.
 * @param {number} [opts.occStart=8]         First occupied hour-of-day.
 * @param {number} [opts.occEnd=17]          Last occupied hour-of-day.
 * @returns {{ sda: number, perSensor: Float64Array, occupiedHours: number }}
 *   sda: fraction of sensors meeting criterion (0–1).
 *   perSensor[s]: fraction of occupied hours ≥ threshold for sensor s.
 */
export function computeSDA(luxMatrix, opts = {}) {
  const {
    luxThreshold = 300,
    fraction     = 0.5,
    occStart     = LM83_OCC_START,
    occEnd       = LM83_OCC_END,
  } = opts;

  const { nSensors, nHours, data } = luxMatrix;
  const mask         = buildOccupancyMask(occStart, occEnd);
  const occupiedTotal = mask.reduce((a, b) => a + b, 0);
  const minHours      = Math.ceil(occupiedTotal * fraction);

  const perSensor    = new Float64Array(nSensors);
  let   sdaCount     = 0;

  for (let s = 0; s < nSensors; s++) {
    let   lit = 0;
    const base = s * nHours;
    for (let t = 0; t < nHours; t++) {
      if (mask[t] && data[base + t] >= luxThreshold) lit++;
    }
    perSensor[s] = lit / occupiedTotal;
    if (lit >= minHours) sdaCount++;
  }

  return {
    sda:           sdaCount / nSensors,
    perSensor,
    occupiedHours: occupiedTotal,
    minHoursReq:   minHours,
  };
}

/**
 * Compute ASE₁₀₀₀,₂₅₀: fraction of sensors with direct-sun illuminance ≥ 1,000 lux
 * for more than 250 occupied hours.
 *
 * @param {{ nSensors, nHours, data: Float64Array }} directLuxMatrix
 *   DIRECT-SUNLIGHT-ONLY illuminance matrix — NOT the sDA matrix.
 *   Must be computed from gendaymtx -d and rcontrib -ab 0.
 * @param {object} [opts]
 * @param {number} [opts.luxThreshold=1000]  Direct illuminance threshold [lux].
 * @param {number} [opts.hourThreshold=250]  Maximum permitted direct-sun hours.
 * @param {number} [opts.occStart=8]
 * @param {number} [opts.occEnd=17]
 * @returns {{ ase: number, perSensor: Float32Array, occupiedHours: number }}
 *   ase: fraction of sensors exceeding the 250-hour direct-sun limit (0–1).
 *   perSensor[s]: number of direct-sun hours for sensor s.
 */
export function computeASE(directLuxMatrix, opts = {}) {
  const {
    luxThreshold  = 1000,
    hourThreshold = 250,
    occStart      = LM83_OCC_START,
    occEnd        = LM83_OCC_END,
  } = opts;

  const { nSensors, nHours, data } = directLuxMatrix;
  const mask         = buildOccupancyMask(occStart, occEnd);
  const occupiedTotal = mask.reduce((a, b) => a + b, 0);

  const perSensor = new Float32Array(nSensors);
  let   aseCount  = 0;

  for (let s = 0; s < nSensors; s++) {
    let   directHours = 0;
    const base = s * nHours;
    for (let t = 0; t < nHours; t++) {
      if (mask[t] && data[base + t] >= luxThreshold) directHours++;
    }
    perSensor[s] = directHours;
    if (directHours > hourThreshold) aseCount++;
  }

  return {
    ase:           aseCount / nSensors,
    perSensor,
    occupiedHours: occupiedTotal,
  };
}

/**
 * Compute Useful Daylight Illuminance (UDI) category distributions from the
 * full annual illuminance matrix. Only the LM-83 occupied schedule is counted.
 *
 * Categories are mutually exclusive and exhaustive for every occupied hour:
 *   failing      f: E < 100 lux
 *   supplemental s: 100 <= E < 300 lux
 *   autonomous   a: 300 <= E <= 3000 lux
 *   excessive    e: E > 3000 lux
 *
 * @param {{ nSensors:number, nHours:number, data:Float64Array|Float32Array }} luxMatrix
 *   Full annual illuminance matrix (direct + diffuse + interreflection).
 * @param {object} [opts]
 * @param {number} [opts.occStart=8]
 * @param {number} [opts.occEnd=17]
 * @returns {{
 *   udi:number,
 *   occupiedHours:number,
 *   udiFailHours:Uint16Array,
 *   udiSupplementalHours:Uint16Array,
 *   udiAutonomousHours:Uint16Array,
 *   udiExcessiveHours:Uint16Array,
 *   udiFailFraction:Float64Array,
 *   udiSupplementalFraction:Float64Array,
 *   udiAutonomousFraction:Float64Array,
 *   udiExcessiveFraction:Float64Array,
 *   averageFailFraction:number,
 *   averageSupplementalFraction:number,
 *   averageAutonomousFraction:number,
 *   averageExcessiveFraction:number,
 *   averages:{failing:number,supplemental:number,autonomous:number,excessive:number}
 * }}
 */
export function computeUDI(luxMatrix, opts = {}) {
  const {
    occStart = LM83_OCC_START,
    occEnd   = LM83_OCC_END,
  } = opts;
  const { nSensors, nHours, data } = luxMatrix ?? {};
  if (!Number.isInteger(nSensors) || nSensors < 0 || !Number.isInteger(nHours) || nHours <= 0 ||
      !data || data.length < nSensors * nHours) {
    throw new Error('computeUDI: invalid annual illuminance matrix');
  }

  const mask = buildOccupancyMask(occStart, occEnd);
  let occupiedTotal = 0;
  for (let t = 0; t < nHours; t++) occupiedTotal += mask[t] ?? 0;
  if (!occupiedTotal) throw new Error('computeUDI: occupancy schedule contains no hours');

  const udiFailHours         = new Uint16Array(nSensors);
  const udiSupplementalHours = new Uint16Array(nSensors);
  const udiAutonomousHours   = new Uint16Array(nSensors);
  const udiExcessiveHours    = new Uint16Array(nSensors);
  const udiFailFraction         = new Float64Array(nSensors);
  const udiSupplementalFraction = new Float64Array(nSensors);
  const udiAutonomousFraction   = new Float64Array(nSensors);
  const udiExcessiveFraction    = new Float64Array(nSensors);

  let failFractionSum = 0;
  let supplementalFractionSum = 0;
  let autonomousFractionSum = 0;
  let excessiveFractionSum = 0;

  for (let s = 0; s < nSensors; s++) {
    let failing = 0, supplemental = 0, autonomous = 0, excessive = 0;
    const base = s * nHours;
    for (let t = 0; t < nHours; t++) {
      if (!mask[t]) continue;
      const lux = data[base + t];
      if (!Number.isFinite(lux)) throw new Error(`computeUDI: non-finite illuminance at sensor ${s}, hour ${t}`);
      if (lux < 100) failing++;
      else if (lux < 300) supplemental++;
      else if (lux <= 3000) autonomous++;
      else excessive++;
    }

    udiFailHours[s] = failing;
    udiSupplementalHours[s] = supplemental;
    udiAutonomousHours[s] = autonomous;
    udiExcessiveHours[s] = excessive;

    const failFraction = failing / occupiedTotal;
    const supplementalFraction = supplemental / occupiedTotal;
    const autonomousFraction = autonomous / occupiedTotal;
    const excessiveFraction = excessive / occupiedTotal;
    udiFailFraction[s] = failFraction;
    udiSupplementalFraction[s] = supplementalFraction;
    udiAutonomousFraction[s] = autonomousFraction;
    udiExcessiveFraction[s] = excessiveFraction;
    failFractionSum += failFraction;
    supplementalFractionSum += supplementalFraction;
    autonomousFractionSum += autonomousFraction;
    excessiveFractionSum += excessiveFraction;
  }

  const denominator = nSensors || 1;
  const averageFailFraction = failFractionSum / denominator;
  const averageSupplementalFraction = supplementalFractionSum / denominator;
  const averageAutonomousFraction = autonomousFractionSum / denominator;
  const averageExcessiveFraction = excessiveFractionSum / denominator;

  return {
    udi: averageAutonomousFraction,
    occupiedHours: occupiedTotal,
    udiFailHours,
    udiSupplementalHours,
    udiAutonomousHours,
    udiExcessiveHours,
    udiFailFraction,
    udiSupplementalFraction,
    udiAutonomousFraction,
    udiExcessiveFraction,
    averageFailFraction,
    averageSupplementalFraction,
    averageAutonomousFraction,
    averageExcessiveFraction,
    averages: {
      failing: averageFailFraction,
      supplemental: averageSupplementalFraction,
      autonomous: averageAutonomousFraction,
      excessive: averageExcessiveFraction,
    },
  };
}
