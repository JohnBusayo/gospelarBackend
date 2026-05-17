// backend/data/membership.js
// Shared canonical option lists for the membership form. Used by:
//   • Mobile app (Gospeler ID form) — fetches via GET /api/membership/options
//   • Registration webapp (gospelarregistration) — currently inlines copies
//     of these lists; the long-term move is to fetch from this endpoint too
//     so the two apps stay in lockstep.
//
// Source of truth: this file. When the denomination adds a new region or
// retires a status code, change it here and both apps pick it up after a
// single backend deploy. Never duplicate these lists into the mobile bundle
// or webapp bundle — fetch them.

// Denomination-specific honorifics. Order is lay → clergy so the lay-majority
// users hit their option first. Secular honorifics (Mr, Mrs, Dr, etc.) were
// removed at the denomination's request — the church-records system this form
// feeds into only recognises in-church titles.
const TITLES = [
  'Brother', 'Sister', 'Deacon', 'Deaconess', 'Elder', 'Evangelist', 'Pastor',
];

// Biological sex (separate from gender expression). Two options is sufficient
// for the church-records system this form feeds into.
const SEXES = ['Male', 'Female'];

// Church membership / role codes. The first three are public-facing labels;
// the rest are internal abbreviations from the denomination's records system.
// IMPORTANT: this list is the source of truth — the mobile + web forms both
// validate against it. To add a new code, add it here and redeploy.
//
//   ACCT    Accountant
//   ADM     Administrator
//   ADP     Assistant District Pastor
//   AGE     Assistant General Evangelist
//   AGO     Assistant General Overseer
//   AGS     Assistant General Secretary
//   DED     Dedicated member
//   GOD     God-parent
//   NDN     New denomination
//   SDP     Senior District Pastor
//   DRI     Director
//   ELD     Elder
//   EVAG    Evangelist
//   GE      General Evangelist
//   GO      General Overseer
//   GS      General Secretary
//   HELPER  Helper
//   HOD     Head of Department
//   IP      In Position
//   NE      New Entrant
//   PASTOR  Pastor
//   RETIRED Retired
//   RP      Regional Pastor
//   SEC     Secretary
//   VISITOR Visitor
const STATUSES = [
  'MEMBER', 'WORKER', 'OTHERS',
  'ACCT', 'ADM', 'ADP', 'AGE', 'AGO', 'AGS',
  'DED', 'GOD', 'NDN', 'SDP',
  'DRI', 'ELD', 'EVAG', 'GE', 'GO', 'GS',
  'HELPER', 'HOD', 'IP', 'NE',
  'PASTOR', 'RETIRED', 'RP', 'SEC', 'VISITOR',
];

const COUNTRIES = [
  'Nigeria', 'Ghana', 'Benin', 'Togo', 'Cameroon', 'Côte d’Ivoire',
  'Kenya', 'South Africa', 'United Kingdom', 'United States', 'Canada', 'Other',
];

// Age brackets — coarser than DOB, used for cohort reporting and routing
// minors to the children's program. `ageGroupFromBracket()` maps a bracket
// onto the legacy 'child'|'teen'|'adult' enum the rest of the platform reads.
const AGE_BRACKETS = [
  'Children (0-12)',
  'Teenager (13-19)',
  'Youth (20-35)',
  'Adult (36-above)',
];

function ageGroupFromBracket(bracket) {
  if (bracket === 'Children (0-12)') return 'child';
  if (bracket === 'Teenager (13-19)') return 'teen';
  return 'adult';
}

// Region → Districts. Sourced from the denomination's records system. Keys
// are the user-facing region label exactly as displayed; values are an array
// of district names within that region. Assembly is captured as free-text
// because the catalog of assemblies is too long + fluid to enumerate.
const REGION_DISTRICTS = {
  // Numbered domestic regions
  'Region 1':  ['Mushin', 'Agege', 'Agbado', 'Alakuko', 'Region 1 Headquarter Church', 'Ayantuga', 'Regional Headquarters', 'Akute'],
  'Region 2':  ['Eleyele', 'Challenge', 'Jesutowoju', 'Oluyole', 'Apata', 'Region 2 Headquarter Church', 'House of Joy Mokola', 'Salvation Army Road', 'Regional Headquarters'],
  'Region 3':  ['Idanre', 'Moferere', 'Obanla', 'Olorunsogo', 'Tutugbua', 'Oke Ogba', 'Regional Headquarters', 'House of Favour (Extension of Regional Church)', 'Alade-Atosin'],
  'Region 4':  ['Benin', 'Delta', 'Etsako', 'Ogida', 'Okhoro', 'Sapele', 'Glory', 'Regional Headquarters'],
  'Region 5':  ['Nyanya', 'Abuja', 'Kubwa', 'Minna', 'Nyanyan'],
  'Region 6':  ['Ife', 'Moore', 'Ilesa', 'Modakeke', 'Ajebamidele', 'Oke Osun', 'Goshen', 'PPS 2', 'Liberty (Origbo)', 'Abundant Life'],
  'Region 7':  ['Eleweran', 'Abeokuta', 'Onikolobo', 'Grace', 'Iberekodo', 'Oke Sokori', 'Region 7 Headquarter Church', 'New Abeokuta', 'New Era (Isale Abetu)', 'Mount Zion', 'Shiloh'],
  'Region 8':  ['Akowojo', 'Egbe', 'Amuwo', 'Idimu', 'Ilasamaja', 'Kingdom House'],
  'Region 9':  ['Ondo', 'New Town', 'Ore', 'Ajegunle', 'Ile Oluji', 'Ademulegun', 'Odigbo', 'Beulah'],
  'Region 10': ['Ado', 'Okela', 'Ikere', 'Adebayo', 'Ikole', 'Pentecost Arena', 'Jubilee', 'Omuo', 'Ido', 'Aramoko'],
  'Region 11': ['Ojoo', 'Gospel Town', 'Oyo', 'Solution Arena', 'Oke Ogun', 'Moniya'],
  'Region 12': ['Ketu', 'Mowe', 'Matogun', 'Ogba', 'Agape', 'Wonders Cathedral', 'Alagbole'],
  'Region 13': ['Port-Harcourt', 'Owerri', 'Mercy', 'Sanctuary of His Glory', 'Goodness'],
  'Region 14': ['Ijebu', 'Remo', 'Ijebu Waterside', 'Oke Igbala', 'Unity', 'Ijebu Igbo Waterside', 'Ijebu Ife Waterside', 'Amazing Grace'],
  'Region 15': ['Ajara', 'Badagry', 'Aradagun', 'Okokomaiko', 'Ibereko', 'Igborosun', 'Border'],
  'Region 16': ['Ikare', 'Oka', 'Ajowa', 'Epinmi', 'Glory Land', 'Arigidi'],
  'Region 17': ['Alakia', 'Olorungbeja', 'Apomu', 'Aremo', 'Ode Aje', 'Victory Cathedral'],
  'Region 18': ['Osogbo', 'Ikirun', 'Ogbomoso', 'Ring Road', 'Ilorin', 'Railway Line'],
  'Region 19': ['Okitipupa', 'Ode Aye', 'Osoro', 'Bethel', 'Irele', 'Igbokoda', 'Achiever', 'Awoye', 'Iretolu', 'Gbeleju'],
  'Region 20': ['Kaduna', 'Sokoto', 'Kano', 'Jos', 'Sabo Kaduna'],
  'Region 21': ['Sango', 'Otta (Devine Mercy)', 'Ilaro', 'Ifo', 'Idiroko', 'Divine Favour', 'Owode Yewa', 'Ipokia', 'Dominion'],
  'Region 22': [],
  'Region 23': [],
  'Region 24': [],
  'Region 25': [],
  'Region 26': [],
  'Region 27': [],
  'Region 28': [],
  'Region 29': [],
  'Region 30': [],

  // International regions
  'Republic of Benin': ['1st District', 'ATLANTIQUE', 'ATACORA', 'BORGOU', 'MONO NORD', 'MONO SUD', 'LITTORAL', 'PLATEAU', 'QUEME', 'ZOU & COLLINE'],
  'Ghana':             ['Ghana'],
  'Republic of Niger': ['Republic of Niger'],
  'Kenya':             ['Kenya'],
  'Liberia':           ['DISTRICT ONE', 'DISTRICT TWO', 'DISTRICT THREE'],
  'Botswana':          ['Botswana'],
  'Cameroon':          ['Cameroon'],
  'Gabon':             ['Gabon'],
  'South Africa':      ['South Africa'],
  'Sierra Leone':      ['Sierra Leone'],
  'Togo':              ['Togo'],
  'Turkey':            ['Turkey'],
  'Egypt':             ['Egypt'],
  'United Kingdom':    ['United Kingdom'],
  'Ireland':           ['Ireland'],
  'Belgium':           ['Belgium'],
  'Australia':         ['Australia'],
  'North America':     ['North America'],
  'Asia':              ['UAE', 'ISRAEL', 'PHILLIPINES'],
  'Uganda':            ['Uganda'],
  'India':             ['India'],

  // GSF (Gospel Students' Fellowship) Fields
  'GSF Lagos Field':    ['Ikorodu', 'Itamaga', 'Ogijo', 'Ijede'],
  'GSF Ogun Field':     ['Owo', 'Okedogbon', 'Ifon', 'Irekari'],
  'GSF Oyo Field':      ['GSF Lagos Zone 1', 'GSF Lagos Zone 2', 'GSF Lagos Zone 3', 'GSF Lagos Zone 4', 'GSF Lagos Zone 5'],
  'GSF Kwara Field':    ['GSF Abeokuta Zone 1', 'GSF Abeokuta Zone 2', 'GSF Abeokuta Zone 3', 'GSF Ijebu Zone 1', 'GSF Ijebu Zone 2', 'GSF Ijebu Zone 3'],
  'GSF Ondo Field':     ['GSF Ibadan Zone 1', 'GSF Ibadan Zone 2', 'GSF Oyo Zone'],
  'GSF Osun Field':     ['GSF Ilorin Zone 1', 'GSF Ilorin Zone 2'],
  'GSF Benin Field':    ['GSF Akure Zone 1', 'GSF Akure Zone 2', 'GSF Ondo Zone', 'GSF Owo Zone'],
  'GSF Kogi Field':     ['GSF Ife Zone 1', 'GSF Ife Zone 2', 'GSF Osogbo Zone', 'GSF Ilesa Zone'],
  'GSF Abuja Field':    ['GSF Benin Zone', 'GSF Delta Zone', 'GSF Port Harcourt Zone', 'GSF Bayelsa Zone'],
  'GSF Diaspora Field': [],
  'GSF Ekiti Field':    [],
};

const REGIONS = Object.keys(REGION_DISTRICTS);

function districtsFor(region) {
  return region ? (REGION_DISTRICTS[region] || []) : [];
}

module.exports = {
  TITLES, SEXES, STATUSES, COUNTRIES, AGE_BRACKETS,
  REGION_DISTRICTS, REGIONS,
  districtsFor, ageGroupFromBracket,
};
