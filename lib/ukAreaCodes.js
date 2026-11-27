// Main geographic phone area codes for each UK postcode area, so a new
// business gets a number its customers recognise as local. The first code
// is the main town of the area; later ones are other large towns in it.
// Codes are written without the leading 0 (01606 -> '1606'), which is how
// Telnyx's national_destination_code filter expects them.
//
// This is a guide, not a complete map -- if none of these codes has a free
// number, the search simply moves on to any UK number.

const POSTCODE_AREA_CODES = {
  AB: ['1224'], AL: ['1727'], B: ['121'], BA: ['1225', '1373'], BB: ['1254', '1282'],
  BD: ['1274'], BH: ['1202'], BL: ['1204'], BN: ['1273', '1903'], BR: ['20'],
  BS: ['117'], BT: ['28'], CA: ['1228'], CB: ['1223'], CF: ['29'], CH: ['1244', '151'],
  CM: ['1245', '1279'], CO: ['1206'], CR: ['20'], CT: ['1227', '1843'], CV: ['24'],
  CW: ['1606', '1270'], DA: ['1322'], DD: ['1382'], DE: ['1332'], DG: ['1387'],
  DH: ['191'], DL: ['1325'], DN: ['1302', '1724'], DT: ['1305'], DY: ['1384'],
  E: ['20'], EC: ['20'], EH: ['131'], EN: ['20', '1992'], EX: ['1392'], FK: ['1324'],
  FY: ['1253'], G: ['141'], GL: ['1452', '1242'], GU: ['1483', '1252'], HA: ['20'],
  HD: ['1484'], HG: ['1423'], HP: ['1494', '1442'], HR: ['1432'], HS: ['1851'],
  HU: ['1482'], HX: ['1422'], IG: ['20'], IP: ['1473'], IV: ['1463'], KA: ['1292', '1563'],
  KT: ['20', '1372'], KW: ['1847'], KY: ['1592', '1383'], L: ['151'], LA: ['1524', '1229'],
  LD: ['1597'], LE: ['116'], LL: ['1492', '1248'], LN: ['1522'], LS: ['113'], LU: ['1582'],
  M: ['161'], ME: ['1634', '1622'], MK: ['1908'], ML: ['1698'], N: ['20'], NE: ['191'],
  NG: ['115'], NN: ['1604', '1536'], NP: ['1633'], NR: ['1603'], NW: ['20'], OL: ['161'],
  OX: ['1865'], PA: ['141', '1475'], PE: ['1733', '1480'], PH: ['1738'], PL: ['1752'],
  PO: ['23'], PR: ['1772', '1704'], RG: ['118', '1635'], RH: ['1293', '1737'], RM: ['1708'],
  S: ['114', '1709'], SA: ['1792', '1554'], SE: ['20'], SG: ['1438', '1462'], SK: ['161', '1625'],
  SL: ['1753', '1628'], SM: ['20'], SN: ['1793'], SO: ['23'], SP: ['1722'], SR: ['191'],
  SS: ['1702', '1268'], ST: ['1782'], SW: ['20'], SY: ['1743', '1970'], TA: ['1823'],
  TD: ['1896'], TF: ['1952'], TN: ['1892', '1732'], TQ: ['1803'], TR: ['1872', '1209'],
  TS: ['1642'], TW: ['20'], UB: ['20', '1895'], W: ['20'], WA: ['1925', '1928'],
  WC: ['20'], WD: ['1923'], WF: ['1924'], WN: ['1942'], WR: ['1905'], WS: ['1922'],
  WV: ['1902'], YO: ['1904', '1723'], ZE: ['1595'],
};

// "CW7 1GU" / "cw71gu" / "Leeds, LS1-LS28" -> "CW" / "CW" / "LS".
function postcodeArea(text) {
  const match = String(text || '').toUpperCase().match(/\b([A-Z]{1,2})\d[A-Z\d]?(?:\s*\d[A-Z]{2})?\b/);
  return match ? match[1] : null;
}

function areaCodesForPostcode(text) {
  const area = postcodeArea(text);
  return (area && POSTCODE_AREA_CODES[area]) || [];
}

// A UK landline's area code, if the number is a geographic one (01/02):
// "01606 123456" -> "1606", "020 7946 0000" -> "20". Mobiles give null.
// Most UK area codes are 3-4 digits after the 0; 02x numbers use 2.
function landlineAreaCode(phone) {
  const digits = String(phone || '').replace(/[^\d+]/g, '').replace(/^\+44/, '0').replace(/^44/, '0');
  if (!/^0[12]\d{8,9}$/.test(digits)) return null;
  if (digits.startsWith('02')) return digits.slice(1, 3);
  if (/^01\d1/.test(digits) || /^011/.test(digits)) return digits.slice(1, 4);
  return digits.slice(1, 5);
}

module.exports = { POSTCODE_AREA_CODES, postcodeArea, areaCodesForPostcode, landlineAreaCode };
