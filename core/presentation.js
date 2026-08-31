/**
 * Select a headline from forecasts that may mix Estimated chances and
 * deterministic Conditions scores. The two scales are not interchangeable:
 * when any estimate is available, compare estimates only. Use scores only
 * when every candidate lacks an estimate.
 */
export function selectBestForecast(candidates = []) {
  const usable = candidates.filter(Boolean);
  const estimates = usable.filter((candidate) => Number.isFinite(candidate.probability));
  const pool = estimates.length
    ? estimates
    : usable.filter((candidate) => Number.isFinite(candidate.score));
  if (!pool.length) return null;

  const value = (candidate) => (estimates.length ? candidate.probability : candidate.score);
  return pool.reduce((best, candidate) => {
    const delta = value(candidate) - value(best);
    if (delta > 0) return candidate;
    if (delta === 0 && (candidate.score ?? 0) > (best.score ?? 0)) return candidate;
    return best;
  });
}
