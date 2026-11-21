/**
 * RADIANCE matrix parsing and DC × sky matrix multiply for CBDM.
 *
 * Sky matrix (from gendaymtx -m 1):
 *   NROWS=146, NCOLS=8760, NCOMP=3, FORMAT=ascii
 *   Row 0 = ground patch (skipped in multiply)
 *   Rows 1..145 = sky patches in Reinhart MF=1 order (= rcontrib bins 0..144)
 *
 * DC matrix (from rcontrib -bn 145 -b rbin -m sky_mat):
 *   NROWS=N_sensors, NCOLS=145, NCOMP=3, FORMAT=ascii
 *   Column p = rcontrib bin p = gendaymtx sky row p+1
 *
 * Efficacy conversion (179 lm/W applied ONCE here, per Radiance RGB channel):
 *   R: 47.4 lm/W  G: 120.0 lm/W  B: 11.6 lm/W  (sum = 179.0)
 *   Source: Radiance RGB primaries convolved with CIE V(λ) photopic response.
 *   Classic double-application bug: pre-multiplying sky values by 179 AND then
 *   also calling rmtxop -c 47.4 120.0 11.6. Apply ONLY in multiplyDC(), once.
 */

const EFFICACY_R = 47.4;   // lm/W for Radiance red primary
const EFFICACY_G = 120.0;  // lm/W for Radiance green primary
const EFFICACY_B = 11.6;   // lm/W for Radiance blue primary

/**
 * Parse a RADIANCE matrix ASCII text (generic: works for sky and DC matrices).
 * Returns { nrows, ncols, ncomp, data: Float64Array }.
 * data is stored row-major: data[(row * ncols + col) * ncomp + comp].
 */
export function parseMatrix(text) {
  const lines = text.split('\n');
  let nrows = 0, ncols = 0, ncomp = 3;
  let afterHeader = false;

  const nums = [];
  for (const line of lines) {
    if (!afterHeader) {
      const t = line.trim();
      if (t.startsWith('NROWS=')) nrows = parseInt(t.slice(6), 10);
      else if (t.startsWith('NCOLS=')) ncols = parseInt(t.slice(6), 10);
      else if (t.startsWith('NCOMP=')) ncomp = parseInt(t.slice(6), 10);
      if (t === '') afterHeader = true;
      continue;
    }
    const t = line.trim();
    if (!t) continue;
    // Each token is a number; split on whitespace/tabs
    for (const tok of t.split(/[\s\t]+/)) {
      if (tok) nums.push(parseFloat(tok));
    }
  }

  if (!ncols || !ncomp) {
    throw new Error(`parseMatrix: missing header fields (nrows=${nrows} ncols=${ncols} ncomp=${ncomp})`);
  }

  // rcontrib does not write NROWS (it streams output); infer from total value count.
  if (!nrows) {
    if (nums.length % (ncols * ncomp) !== 0) {
      throw new Error(
        `parseMatrix: value count ${nums.length} not divisible by ncols×ncomp=${ncols * ncomp}`
      );
    }
    nrows = nums.length / (ncols * ncomp);
  }

  const expected = nrows * ncols * ncomp;
  if (nums.length !== expected) {
    throw new Error(
      `parseMatrix: expected ${expected} values (${nrows}×${ncols}×${ncomp}), got ${nums.length}`
    );
  }

  return { nrows, ncols, ncomp, data: new Float64Array(nums) };
}

/**
 * Multiply the DC transfer matrix by the annual sky matrix to produce the
 * annual illuminance matrix.
 *
 * @param {object} dc   Parsed DC matrix: { nrows=N_sensors, ncols=145, ncomp=3 }
 * @param {object} sky  Parsed sky matrix: { nrows=146, ncols=8760, ncomp=3 }
 * @returns {{ nSensors, nHours, data: Float64Array }}
 *   data[s * nHours + t] = illuminance in lux at sensor s, hour t.
 *
 * Patch alignment:
 *   DC column p (0..N_patches-1) = sky row p+1 (skip row 0 = ground).
 *   Both use the same Reinhart MF=1 patch ordering.
 *
 * Efficacy: [47.4, 120.0, 11.6] lm/W applied ONCE here, per channel.
 */
export function multiplyDC(dc, sky) {
  const N_sensors = dc.nrows;
  const N_patches = dc.ncols;   // 145 for Reinhart MF=1
  const N_hours   = sky.ncols;  // 8760

  if (dc.ncomp !== 3 || sky.ncomp !== 3) {
    throw new Error('multiplyDC: both matrices must have NCOMP=3');
  }
  if (sky.nrows !== N_patches + 1) {
    throw new Error(
      `multiplyDC: sky NROWS=${sky.nrows} must equal DC NCOLS+1=${N_patches + 1} ` +
      '(row 0 is the ground patch, rows 1..N_patches are sky patches)'
    );
  }

  const { data: dcData }  = dc;
  const { data: skyData } = sky;
  const lux = new Float64Array(N_sensors * N_hours);

  for (let s = 0; s < N_sensors; s++) {
    for (let p = 0; p < N_patches; p++) {
      // DC flat base for (sensor s, patch p): row-major (sensor, patch, channel)
      const dcBase  = (s * N_patches + p) * 3;
      // Sky flat base for row p+1 (0-indexed sky row p+1 = Reinhart patch p+1):
      // row-major (sky_row, hour, channel)
      const skyBase = (p + 1) * N_hours * 3;

      const dc_R = dcData[dcBase    ] * EFFICACY_R;
      const dc_G = dcData[dcBase + 1] * EFFICACY_G;
      const dc_B = dcData[dcBase + 2] * EFFICACY_B;

      // Inner loop: only hours, no branches.
      for (let t = 0; t < N_hours; t++) {
        const st = skyBase + t * 3;
        lux[s * N_hours + t] +=
          dc_R * skyData[st    ] +
          dc_G * skyData[st + 1] +
          dc_B * skyData[st + 2];
      }
    }
  }

  return { nSensors: N_sensors, nHours: N_hours, data: lux };
}

/**
 * Average N independently-sampled DC matrices into one.
 *
 * Used by the multi-seed parallel pipeline: N workers each compute the same
 * sensor grid with c/N samples and a unique seed, then the results are averaged.
 * Averaging N independent Monte Carlo estimates is standard variance reduction —
 * the expectation is identical to a single run with the same total sample budget,
 * but with lower variance (each worker explores a different region of the
 * hemisphere sample space).
 *
 * @param {Array<{nrows,ncols,ncomp,data:Float64Array}>} dcs  — N parsed DC matrices
 * @returns {{nrows,ncols,ncomp,data:Float64Array}}
 */
export function averageDC(dcs) {
  if (!dcs.length) throw new Error('averageDC: empty array');
  const { nrows, ncols, ncomp } = dcs[0];
  const n = dcs.length;
  const merged = new Float64Array(nrows * ncols * ncomp);
  for (const dc of dcs) {
    const { data } = dc;
    for (let i = 0; i < merged.length; i++) merged[i] += data[i];
  }
  const inv = 1 / n;
  for (let i = 0; i < merged.length; i++) merged[i] *= inv;
  return { nrows, ncols, ncomp, data: merged };
}
