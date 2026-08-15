/**
 * The "distance" sort, meant literally. The site's own sort ranks by distance from the address Clalit
 * has on file; when it is active the finished list is re-ranked by distance from the user's LIVE
 * position instead, using the committed clinic coordinates so nothing extra is fetched at runtime.
 *
 * Stable by construction: rows without known coordinates keep the server's order at the end, and a
 * denied or unavailable position leaves the list exactly as the server sorted it.
 */

import { clinicCoords } from "./clinic-coord-fixes";
import { haversineKm, type LatLng, POSITION_MAX_AGE_MS } from "./geo";
import { requestPosition } from "./page-position";
import { rowNavCode, setRowDistanceLabel } from "./smile";

export function createLiveDistanceSort(isActive: () => boolean) {
  let cachedPosition: {
    coords: LatLng;
    fetchedAt: number;
  } | null = null;

  /** One fix per list: the same rendered list asks for distances, labels and a re-rank in turn. */
  async function currentPosition() {
    if (cachedPosition && Date.now() - cachedPosition.fetchedAt < POSITION_MAX_AGE_MS) {
      return cachedPosition.coords;
    }

    const coords = await requestPosition();
    if (!coords) {
      return null;
    }

    cachedPosition = {
      coords,
      fetchedAt: Date.now()
    };
    return coords;
  }

  /**
   * How far these branches are from the user right now, by nav code - the line an appended row needs to
   * read like a server row, which prints a distance on every result. Best effort: a denied or missing
   * position simply means no line, exactly as before.
   */
  async function distancesByNavCode(navCodes: string[]) {
    const distances = new Map<string, number>();
    const position = await currentPosition();
    if (!position) {
      return distances;
    }

    for (const navCode of navCodes) {
      const coords = clinicCoords(navCode);
      if (coords) {
        distances.set(
          navCode, haversineKm({
            from: position,
            to: coords
          })
        );
      }
    }

    return distances;
  }

  /**
   * Put every row's distance on the same footing: the server prints distance from the address Clalit has
   * on file, ours from where the user actually is, and a list that mixes the two is a list with two
   * different numbers under one heading. Rows whose clinic is not in the committed directory keep the
   * server's line - a number from the wrong origin still beats no number at all.
   */
  async function relabelRows(elList: Element) {
    const position = await currentPosition();
    if (!position) {
      return;
    }

    for (const elRow of elList.querySelectorAll("li.diary")) {
      const coords = clinicCoords(rowNavCode(elRow));
      if (coords) {
        setRowDistanceLabel({
          elRow,
          km: haversineKm({
            from: position,
            to: coords
          })
        });
      }
    }
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
      const coords = clinicCoords(rowNavCode(elRow));
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

  return {
    reorder,
    distancesByNavCode,
    relabelRows
  };
}
