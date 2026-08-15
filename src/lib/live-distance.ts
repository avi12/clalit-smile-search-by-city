/**
 * The "distance" sort, meant literally. The site's own sort ranks by distance from the address Clalit
 * has on file; when it is active the finished list is re-ranked by distance from the user's LIVE
 * position instead, using the committed clinic coordinates so nothing extra is fetched at runtime.
 *
 * Stable by construction: rows without known coordinates keep the server's order at the end, and a
 * denied or unavailable position leaves the list exactly as the server sorted it.
 */

import { DENTAL_CLINIC_COORDS } from "./clinic-directory";
import { haversineKm, type LatLng } from "./geo";
import { rowNavCode, setRowDistanceLabel } from "./smile";

const POSITION_MAX_AGE_MS = 120_000;

export function createLiveDistanceSort(isActive: () => boolean) {
  let cachedPosition: {
    coords: LatLng;
    fetchedAt: number;
  } | null = null;

  function currentPosition() {
    if (cachedPosition && Date.now() - cachedPosition.fetchedAt < POSITION_MAX_AGE_MS) {
      return Promise.resolve(cachedPosition.coords);
    }

    return new Promise<LatLng | null>(resolve => {
      if (!("geolocation" in navigator)) {
        resolve(null);
        return;
      }

      navigator.geolocation.getCurrentPosition(
        ({ coords: { latitude, longitude } }) => {
          cachedPosition = {
            coords: [latitude, longitude],
            fetchedAt: Date.now()
          };
          resolve(cachedPosition.coords);
        },
        () => resolve(null),
        {
          enableHighAccuracy: false,
          timeout: 8000,
          maximumAge: POSITION_MAX_AGE_MS
        }
      );
    });
  }

  /** Re-rank the finished list by great-circle distance from the user's live position. */
  async function reorder({ elList, isDescending }: {
    elList: Element;
    isDescending: boolean;
  }) {
    const position = await currentPosition();
    if (!position || !isActive()) {
      return;
    }

    const ranked = [...elList.querySelectorAll("li.diary")].map((elRow, i) => {
      const coords = DENTAL_CLINIC_COORDS[rowNavCode(elRow)];
      return {
        elRow,
        iRow: i,
        km: coords ? haversineKm({
          from: position,
          to: coords
        }) : Number.POSITIVE_INFINITY
      };
    });
    ranked.sort((first, second) => {
      const isFirstKnown = Number.isFinite(first.km);
      const isSecondKnown = Number.isFinite(second.km);
      if (isFirstKnown !== isSecondKnown) {
        return isFirstKnown ? -1 : 1;
      }

      let delta = 0;
      if (isFirstKnown) {
        delta = isDescending ? second.km - first.km : first.km - second.km;
      }

      return delta || first.iRow - second.iRow;
    });
    for (const { elRow, km } of ranked) {
      elList.appendChild(elRow);

      if (Number.isFinite(km)) {
        setRowDistanceLabel({
          elRow,
          km
        });
      }
    }
  }

  return { reorder };
}
