/**
 * Clalit Smile clinic directory — extracted from the booking site's own embedded dataset
 * (www.clalitsmile.co.il → __NEXT_DATA__ → pageProps.forms.dynamicForm.treatments[].clinics).
 * 111 unique clinics, each with its Clalit `clinicCode` and the city parsed out of the branch label.
 *
 * Why the extension keeps this: to turn a typed city ("תל אביב") into the concrete clinic codes in
 * that city, which is the most reliable way to match appointment rows regardless of how the API labels
 * them. See docs/reverse-engineering.md § "Clinic dataset".
 *
 * ⚠ Caveat: these are the Clalit Smile SPECIALTY clinics (codes 9xxx). The Tamuz hygienist flow may
 * expose a different/overlapping code set — confirm against a real capture and extend if needed.
 */

import { normalizeCity } from "./text";

export interface Clinic {
  /** Clalit clinic code, e.g. "9007". */
  code: string;
  /** Base city, e.g. "תל אביב". */
  city: string;
  /** Branch qualifier within the city, e.g. "איילון" (may be empty). */
  branch: string;
  /** Full original label. */
  label: string;
}

export const CLINICS: Clinic[] = [
  {
    code: "9002",
    city: "ירושלים",
    branch: "מעוז",
    label: "מרפאת כללית סמייל ירושלים – מעוז"
  },
  {
    code: "9004",
    city: "מגדל המאה",
    branch: "",
    label: "מרפאת כללית סמייל מגדל המאה"
  },
  {
    code: "9007",
    city: "תל אביב",
    branch: "איילון",
    label: "מרפאת כללית סמייל תל אביב – איילון"
  },
  {
    code: "9014",
    city: "חולון",
    branch: "החלוץ",
    label: "מרפאת כללית סמייל חולון – החלוץ"
  },
  {
    code: "9016",
    city: "קרית אונו",
    branch: "קניון",
    label: "מרפאת כללית סמייל קרית אונו – קניון"
  },
  {
    code: "9017",
    city: "בני ברק בלומנטל",
    branch: "",
    label: "מרפאת כללית סמייל בני ברק בלומנטל"
  },
  {
    code: "9019",
    city: "גבעתיים",
    branch: "",
    label: "מרפאת כללית סמייל גבעתיים"
  },
  {
    code: "9020",
    city: "חיפה",
    branch: "ארמון",
    label: "מרפאת כללית סמייל חיפה – ארמון"
  },
  {
    code: "9021",
    city: "קרית אתא",
    branch: "",
    label: "מרפאת כללית סמייל קרית אתא"
  },
  {
    code: "9022",
    city: "טירת הכרמל",
    branch: "",
    label: "מרפאת כללית סמייל טירת הכרמל"
  },
  {
    code: "9023",
    city: "חיפה",
    branch: "גרנד קניון",
    label: "מרפאת כללית סמייל חיפה – גרנד קניון"
  },
  {
    code: "9026",
    city: "נהריה",
    branch: "",
    label: "מרפאת כללית סמייל נהריה"
  },
  {
    code: "9027",
    city: "רחובות",
    branch: "רמז",
    label: "מרפאת כללית סמייל רחובות – רמז"
  },
  {
    code: "9029",
    city: "ראשון לציון",
    branch: "רוטשילד",
    label: "מרפאת כללית סמייל ראשון לציון – רוטשילד"
  },
  {
    code: "9031",
    city: "באר שבע",
    branch: "בן-יאיר",
    label: "מרפאת כללית סמייל באר שבע – בן-יאיר"
  },
  {
    code: "9032",
    city: "דימונה",
    branch: "",
    label: "מרפאת כללית סמייל דימונה"
  },
  {
    code: "9036",
    city: "ערד",
    branch: "",
    label: "מרפאת כללית סמייל ערד"
  },
  {
    code: "9037",
    city: "קרית גת",
    branch: "",
    label: "מרפאת כללית סמייל קרית גת"
  },
  {
    code: "9039",
    city: "פתח תקווה",
    branch: "מרכז",
    label: "מרפאת כללית סמייל פתח תקווה – מרכז"
  },
  {
    code: "9041",
    city: "הוד השרון",
    branch: "",
    label: "מרפאת כללית סמייל הוד השרון"
  },
  {
    code: "9042",
    city: "רעננה נווה זמר",
    branch: "",
    label: "מרפאת כללית סמייל רעננה נווה זמר"
  },
  {
    code: "9044",
    city: "כפר סבא ויצמן",
    branch: "",
    label: "מרפאת כללית סמייל כפר סבא ויצמן"
  },
  {
    code: "9045",
    city: "נתניה",
    branch: "רמז",
    label: "מרפאת כללית סמייל נתניה – רמז"
  },
  {
    code: "9047",
    city: "קניון עזריאלי",
    branch: "מודיעין",
    label: "מרפאת כללית סמייל קניון עזריאלי – מודיעין"
  },
  {
    code: "9059",
    city: "קרית שמונה",
    branch: "",
    label: "מרפאת כללית סמייל קרית שמונה"
  },
  {
    code: "9070",
    city: "רמת ישי",
    branch: "",
    label: "מרפאת כללית סמייל רמת ישי"
  },
  {
    code: "9071",
    city: "טבריה",
    branch: "",
    label: "מרפאת כללית סמייל טבריה"
  },
  {
    code: "9077",
    city: "ראש העין",
    branch: "נווה אפק",
    label: "מרפאת כללית סמייל ראש העין – נווה אפק"
  },
  {
    code: "9090",
    city: "תל אביב",
    branch: "ירמיהו",
    label: "מרפאת כללית סמייל תל אביב – ירמיהו"
  },
  {
    code: "9091",
    city: "בת ים",
    branch: "רוטשילד",
    label: "מרפאת כללית סמייל בת ים – רוטשילד"
  },
  {
    code: "9096",
    city: "באר שבע",
    branch: "יסקי",
    label: "מרפאת כללית סמייל באר שבע – יסקי"
  },
  {
    code: "9098",
    city: "ירושלים",
    branch: "קרית היובל",
    label: "מרפאת כללית סמייל ירושלים – קרית היובל"
  },
  {
    code: "9099",
    city: "ירושלים",
    branch: "גילה",
    label: "מרפאת כללית סמייל ירושלים – גילה"
  },
  {
    code: "9102",
    city: "ירושלים",
    branch: "הר נוף",
    label: "מרפאת כללית סמייל ירושלים – הר נוף"
  },
  {
    code: "9103",
    city: "באר שבע",
    branch: "בית הנשיאים",
    label: "מרפאת כללית סמייל באר שבע – בית הנשיאים"
  },
  {
    code: "9104",
    city: "שדרות",
    branch: "",
    label: "מרפאת כללית סמייל שדרות"
  },
  {
    code: "9151",
    city: "נוף הגליל",
    branch: "",
    label: "מרפאת כללית סמייל נוף הגליל"
  },
  {
    code: "9163",
    city: "עכו",
    branch: "",
    label: "מרפאת כללית סמייל עכו"
  },
  {
    code: "9165",
    city: "בית שאן",
    branch: "",
    label: "מרפאת כללית סמייל בית שאן"
  },
  {
    code: "9167",
    city: "אשקלון",
    branch: "",
    label: "מרפאת כללית סמייל אשקלון"
  },
  {
    code: "9174",
    city: "עפולה",
    branch: "הגן",
    label: "מרפאת כללית סמייל עפולה – הגן"
  },
  {
    code: "9176",
    city: "תל מונד",
    branch: "",
    label: "מרפאת כללית סמייל תל מונד"
  },
  {
    code: "9179",
    city: "אשדוד דמרי",
    branch: "",
    label: "מרפאת כללית סמייל אשדוד דמרי"
  },
  {
    code: "9181",
    city: "ירושלים",
    branch: "פסגת זאב",
    label: "מרפאת כללית סמייל ירושלים – פסגת זאב"
  },
  {
    code: "9182",
    city: "רמת גן",
    branch: "הרצל",
    label: "מרפאת כללית סמייל רמת גן – הרצל"
  },
  {
    code: "9183",
    city: "לוד",
    branch: "",
    label: "מרפאת כללית סמייל לוד"
  },
  {
    code: "9184",
    city: "נשר רמות יצחק",
    branch: "",
    label: "מרפאת כללית סמייל נשר רמות יצחק"
  },
  {
    code: "9185",
    city: "קרית ביאליק",
    branch: "",
    label: "מרפאת כללית סמייל קרית ביאליק"
  },
  {
    code: "9188",
    city: "הרצליה",
    branch: "",
    label: "מרפאת כללית סמייל הרצליה"
  },
  {
    code: "9189",
    city: "כרמיאל",
    branch: "",
    label: "מרפאת כללית סמייל כרמיאל"
  },
  {
    code: "9190",
    city: "שוהם",
    branch: "",
    label: "מרפאת כללית סמייל שוהם"
  },
  {
    code: "9701",
    city: "נס ציונה",
    branch: "",
    label: "מרפאת כללית סמייל נס ציונה"
  },
  {
    code: "9702",
    city: "ראשון לציון",
    branch: "ווסט מערב",
    label: "מרפאת כללית סמייל ראשון לציון – ווסט מערב"
  },
  {
    code: "9703",
    city: "אילת",
    branch: "",
    label: "מרפאת כללית סמייל אילת"
  },
  {
    code: "9705",
    city: "פתח תקווה",
    branch: "אם המושבות",
    label: "מרפאת כללית סמייל פתח תקווה – אם המושבות"
  },
  {
    code: "9708",
    city: "צפת",
    branch: "",
    label: "מרפאת כללית סמייל צפת"
  },
  {
    code: "9709",
    city: "בת ים",
    branch: "בתימון",
    label: "מרפאת כללית סמייל בת ים – בתימון"
  },
  {
    code: "9710",
    city: "אופקים",
    branch: "",
    label: "מרפאת כללית סמייל אופקים"
  },
  {
    code: "9712",
    city: "בית שמש",
    branch: "",
    label: "מרפאת כללית סמייל בית שמש"
  },
  {
    code: "9713",
    city: "חולון",
    branch: "קרית רבין",
    label: "מרפאת כללית סמייל חולון – קרית רבין"
  },
  {
    code: "9714",
    city: "חדרה",
    branch: "",
    label: "מרפאת כללית סמייל חדרה"
  },
  {
    code: "9715",
    city: "יבנה",
    branch: "",
    label: "מרפאת כללית סמייל יבנה"
  },
  {
    code: "9716",
    city: "חיפה",
    branch: "אודיטוריום",
    label: "מרפאת כללית סמייל חיפה – אודיטוריום"
  },
  {
    code: "9717",
    city: "קרית מלאכי",
    branch: "",
    label: "מרפאת כללית סמייל קרית מלאכי"
  },
  {
    code: "9718",
    city: "תל אביב",
    branch: "רמת אביב",
    label: "מרפאת כללית סמייל תל אביב – רמת אביב"
  },
  {
    code: "9719",
    city: "אלעד",
    branch: "",
    label: "מרפאת כללית סמייל אלעד"
  },
  {
    code: "9721",
    city: "לב הרמה",
    branch: "רמת בית שמש",
    label: "מרפאת כללית סמייל לב הרמה – רמת בית שמש"
  },
  {
    code: "9722",
    city: "גדרה",
    branch: "",
    label: "מרפאת כללית סמייל גדרה"
  },
  {
    code: "9725",
    city: "נתיבות",
    branch: "",
    label: "מרפאת כללית סמייל נתיבות"
  },
  {
    code: "9729",
    city: "מודיעין עילית",
    branch: "",
    label: "מרפאת כללית סמייל מודיעין עילית"
  },
  {
    code: "9731",
    city: "יקנעם",
    branch: "",
    label: "מרפאת כללית סמייל יקנעם"
  },
  {
    code: "9732",
    city: "מגדל העמק",
    branch: "",
    label: "מרפאת כללית סמייל מגדל העמק"
  },
  {
    code: "9733",
    city: "מעלה אדומים",
    branch: "",
    label: "מרפאת כללית סמייל מעלה אדומים"
  },
  {
    code: "9734",
    city: "רמלה",
    branch: "",
    label: "מרפאת כללית סמייל רמלה"
  },
  {
    code: "9736",
    city: "ירושלים",
    branch: "שיח ג'ארח",
    label: "מרפאת כללית סמייל ירושלים – שיח ג'ארח"
  },
  {
    code: "9737",
    city: "ביתר עילית",
    branch: "",
    label: "מרפאת כללית סמייל ביתר עילית"
  },
  {
    code: "9738",
    city: "רחובות",
    branch: "היובל",
    label: "מרפאת כללית סמייל רחובות – היובל"
  },
  {
    code: "9740",
    city: "אשדוד שפירא",
    branch: "",
    label: "מרפאת כללית סמייל אשדוד שפירא"
  },
  {
    code: "9741",
    city: "באר שבע",
    branch: "נווה זאב",
    label: "מרפאת כללית סמייל באר שבע – נווה זאב"
  },
  {
    code: "9743",
    city: "נצרת",
    branch: "",
    label: "מרפאת כללית סמייל נצרת"
  },
  {
    code: "9744",
    city: "אור יהודה",
    branch: "",
    label: "מרפאת כללית סמייל אור יהודה"
  },
  {
    code: "9745",
    city: "אום אל פאחם",
    branch: "",
    label: "מרפאת כללית סמייל אום אל פאחם"
  },
  {
    code: "9746",
    city: "פרדס חנה",
    branch: "",
    label: "מרפאת כללית סמייל פרדס חנה"
  },
  {
    code: "9747",
    city: "באר יעקב",
    branch: "",
    label: "מרפאת כללית סמייל באר יעקב"
  },
  {
    code: "9752",
    city: "פתח תקווה",
    branch: "סירקין",
    label: "מרפאת כללית סמייל פתח תקווה – סירקין"
  },
  {
    code: "9753",
    city: "מזכרת בתיה",
    branch: "",
    label: "מרפאת כללית סמייל מזכרת בתיה"
  },
  {
    code: "9754",
    city: "ירושלים",
    branch: "קניון מלחה",
    label: "מרפאת כללית סמייל ירושלים – קניון מלחה"
  },
  {
    code: "9756",
    city: "נתניה",
    branch: "קריית השרון",
    label: "מרפאת כללית סמייל נתניה – קריית השרון"
  },
  {
    code: "9758",
    city: "פתח תקווה",
    branch: "כפר גנים",
    label: "מרפאת כללית סמייל פתח תקווה – כפר גנים"
  },
  {
    code: "9760",
    city: "רחובות",
    branch: "פארק המדע",
    label: "מרפאת כללית סמייל רחובות – פארק המדע"
  },
  {
    code: "9761",
    city: "חצור הגלילית",
    branch: "",
    label: "מרפאת כללית סמייל חצור הגלילית"
  },
  {
    code: "9762",
    city: "כפר סבא הירוקה",
    branch: "",
    label: "מרפאת כללית סמייל כפר סבא הירוקה"
  },
  {
    code: "9763",
    city: "ירושלים",
    branch: "רוממה",
    label: "מרפאת כללית סמייל ירושלים – רוממה"
  },
  {
    code: "9764",
    city: "עפולה",
    branch: "רבין",
    label: "מרפאת כללית סמייל עפולה – רבין"
  },
  {
    code: "9766",
    city: "פתח תקווה",
    branch: "הסיבים",
    label: "מרפאת כללית סמייל פתח תקווה – הסיבים"
  },
  {
    code: "9767",
    city: "אריאל",
    branch: "",
    label: "מרפאת כללית סמייל אריאל"
  },
  {
    code: "9768",
    city: "ראש העין",
    branch: "שבזי",
    label: "מרפאת כללית סמייל ראש העין – שבזי"
  },
  {
    code: "9771",
    city: "נתניה",
    branch: "עיר ימים",
    label: "מרפאת כללית סמייל נתניה – עיר ימים"
  },
  {
    code: "9772",
    city: "אשקלון",
    branch: "תהילה",
    label: "מרפאת כללית סמייל אשקלון – תהילה"
  },
  {
    code: "9775",
    city: "כרמי גת",
    branch: "",
    label: "מרפאת כללית סמייל כרמי גת"
  },
  {
    code: "9776",
    city: "נתיבות",
    branch: "גני טל",
    label: "מרפאת כללית סמייל נתיבות – גני טל"
  },
  {
    code: "9778",
    city: "רמת בית שמש",
    branch: "עמוס רמה ג'",
    label: "מרפאת כללית סמייל רמת בית שמש – עמוס רמה ג'"
  },
  {
    code: "9785",
    city: "חריש",
    branch: "",
    label: "מרפאת כללית סמייל חריש"
  },
  {
    code: "9787",
    city: "אור עקיבא",
    branch: "",
    label: "מרפאת כללית סמייל אור עקיבא"
  },
  {
    code: "9791",
    city: "בני ברק המכבים",
    branch: "",
    label: "מרפאת כללית סמייל בני ברק המכבים"
  },
  {
    code: "9792",
    city: "קרית ביאליק מרפאת ילדים",
    branch: "",
    label: "מרפאת כללית סמייל קרית ביאליק מרפאת ילדים"
  },
  {
    code: "9794",
    city: "עמנואל",
    branch: "",
    label: "מרפאת כללית סמייל עמנואל"
  },
  {
    code: "9796",
    city: "אלעזר",
    branch: "",
    label: "מרפאת כללית סמייל אלעזר"
  },
  {
    code: "9910",
    city: "רהט",
    branch: "",
    label: "מרפאת כללית סמייל רהט"
  },
  {
    code: "9912",
    city: "ג'לג'וליה",
    branch: "",
    label: "מרפאת כללית סמייל ג'לג'וליה"
  },
  {
    code: "9913",
    city: "עראבה זכיינות",
    branch: "",
    label: "מרפאת כללית סמייל עראבה זכיינות"
  }
];

const CODE_TO_CLINIC = new Map(CLINICS.map(clinic => [clinic.code, clinic]));

export function getClinicByCode(code: string): Clinic | undefined {
  return CODE_TO_CLINIC.get(code);
}

/**
 * Clinics whose city (or full label) matches the query, tolerant in both directions so "בית שמש"
 * finds "רמת בית שמש" and "תל אביב" finds every תל אביב branch.
 */
export function clinicsForCity(query: string): Clinic[] {
  const needle = normalizeCity(query);
  if (!needle) {
    return [];
  }

  return CLINICS.filter(clinic => {
    const city = normalizeCity(clinic.city);
    const label = normalizeCity(clinic.label);
    return city.includes(needle) || needle.includes(city) || label.includes(needle);
  });
}

export function clinicCodesForCity(query: string): string[] {
  return clinicsForCity(query).map(({ code }) => code);
}

/** Distinct base cities, sorted — for the popup's datalist / autocomplete. */
export function allCities(): string[] {
  return [...new Set(CLINICS.map(({ city }) => city))].sort((first, second) => first.localeCompare(second, "he"));
}
