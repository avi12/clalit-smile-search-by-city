/** Pure geodesic helpers for live-location ranking. Dependency-free (MAIN-world safe). */

export type LatLng = readonly [number, number];

/**
 * How long one fix stands. The offscreen document hands it to `getCurrentPosition` as `maximumAge` and
 * the MAIN-world re-rank uses the same window to decide whether to ask again - two numbers that must
 * agree, so they are one.
 */
export const POSITION_MAX_AGE_MS = 120_000;
export const POSITION_TIMEOUT_MS = 8000;

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number) {
  return (degrees * Math.PI) / 180;
}

/** Great-circle ("as the crow flies") distance between two points, in km. */
export function haversineKm({ from, to }: {
  from: LatLng;
  to: LatLng;
}) {
  const [fromLat, fromLng] = from;
  const [toLat, toLng] = to;
  const deltaLat = toRadians(toLat - fromLat);
  const deltaLng = toRadians(toLng - fromLng);
  const height =
    Math.sin(deltaLat / 2) ** 2 +
    Math.cos(toRadians(fromLat)) * Math.cos(toRadians(toLat)) * Math.sin(deltaLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(height));
}
