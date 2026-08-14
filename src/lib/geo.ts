/** Pure geodesic helpers for live-location ranking. Dependency-free (MAIN-world safe). */

export type LatLng = readonly [number, number];

const EARTH_RADIUS_KM = 6371;

function toRadians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** Great-circle ("as the crow flies") distance between two points, in km. */
export function haversineKm({ from, to }: {
  from: LatLng;
  to: LatLng;
}): number {
  const dLat = toRadians(to[0] - from[0]);
  const dLng = toRadians(to[1] - from[1]);
  const height =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(from[0])) * Math.cos(toRadians(to[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(height));
}
