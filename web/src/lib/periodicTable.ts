/**
 * An ACCURATE, coloured periodic table — authored from canonical data, NOT an AI redraw of the
 * scan. The book prints it in black and white and a vision-model recreation of a reference this
 * dense would invent wrong atomic masses; here every symbol, atomic number and standard atomic
 * weight is exact, so it can be used to read masses and solve exercises. Colour encodes the element
 * family (the scan cannot). Inserted into a figure via the Convert row; rendered like any figure SVG.
 *
 * Each row: [Z, symbol, name (fr), standard atomic weight, category, gridX (1-18), gridY (1-9)].
 * gridY 8/9 are the lanthanide/actinide rows shown below the main table.
 */
export const ELEMENTS: [number,string,string,string,string,number,number][] = [
  [1,'H','Hydrogène','1,008','nonmetal',1,1], [2,'He','Hélium','4,003','noble',18,1], [3,'Li','Lithium','6,94','alkali',1,2], [4,'Be','Béryllium','9,012','alkaline',2,2], [5,'B','Bore','10,81','metalloid',13,2], [6,'C','Carbone','12,01','nonmetal',14,2],
  [7,'N','Azote','14,01','nonmetal',15,2], [8,'O','Oxygène','16,00','nonmetal',16,2], [9,'F','Fluor','19,00','halogen',17,2], [10,'Ne','Néon','20,18','noble',18,2], [11,'Na','Sodium','22,99','alkali',1,3], [12,'Mg','Magnésium','24,31','alkaline',2,3],
  [13,'Al','Aluminium','26,98','post',13,3], [14,'Si','Silicium','28,09','metalloid',14,3], [15,'P','Phosphore','30,97','nonmetal',15,3], [16,'S','Soufre','32,07','nonmetal',16,3], [17,'Cl','Chlore','35,45','halogen',17,3], [18,'Ar','Argon','39,95','noble',18,3],
  [19,'K','Potassium','39,10','alkali',1,4], [20,'Ca','Calcium','40,08','alkaline',2,4], [21,'Sc','Scandium','44,96','tm',3,4], [22,'Ti','Titane','47,87','tm',4,4], [23,'V','Vanadium','50,94','tm',5,4], [24,'Cr','Chrome','52,00','tm',6,4],
  [25,'Mn','Manganèse','54,94','tm',7,4], [26,'Fe','Fer','55,85','tm',8,4], [27,'Co','Cobalt','58,93','tm',9,4], [28,'Ni','Nickel','58,69','tm',10,4], [29,'Cu','Cuivre','63,55','tm',11,4], [30,'Zn','Zinc','65,38','tm',12,4],
  [31,'Ga','Gallium','69,72','post',13,4], [32,'Ge','Germanium','72,63','metalloid',14,4], [33,'As','Arsenic','74,92','metalloid',15,4], [34,'Se','Sélénium','78,97','nonmetal',16,4], [35,'Br','Brome','79,90','halogen',17,4], [36,'Kr','Krypton','83,80','noble',18,4],
  [37,'Rb','Rubidium','85,47','alkali',1,5], [38,'Sr','Strontium','87,62','alkaline',2,5], [39,'Y','Yttrium','88,91','tm',3,5], [40,'Zr','Zirconium','91,22','tm',4,5], [41,'Nb','Niobium','92,91','tm',5,5], [42,'Mo','Molybdène','95,95','tm',6,5],
  [43,'Tc','Technétium','[98]','tm',7,5], [44,'Ru','Ruthénium','101,1','tm',8,5], [45,'Rh','Rhodium','102,9','tm',9,5], [46,'Pd','Palladium','106,4','tm',10,5], [47,'Ag','Argent','107,9','tm',11,5], [48,'Cd','Cadmium','112,4','tm',12,5],
  [49,'In','Indium','114,8','post',13,5], [50,'Sn','Étain','118,7','post',14,5], [51,'Sb','Antimoine','121,8','metalloid',15,5], [52,'Te','Tellure','127,6','metalloid',16,5], [53,'I','Iode','126,9','halogen',17,5], [54,'Xe','Xénon','131,3','noble',18,5],
  [55,'Cs','Césium','132,9','alkali',1,6], [56,'Ba','Baryum','137,3','alkaline',2,6], [57,'La','Lanthane','138,9','lan',3,8], [58,'Ce','Cérium','140,1','lan',4,8], [59,'Pr','Praséodyme','140,9','lan',5,8], [60,'Nd','Néodyme','144,2','lan',6,8],
  [61,'Pm','Prométhium','[145]','lan',7,8], [62,'Sm','Samarium','150,4','lan',8,8], [63,'Eu','Europium','152,0','lan',9,8], [64,'Gd','Gadolinium','157,3','lan',10,8], [65,'Tb','Terbium','158,9','lan',11,8], [66,'Dy','Dysprosium','162,5','lan',12,8],
  [67,'Ho','Holmium','164,9','lan',13,8], [68,'Er','Erbium','167,3','lan',14,8], [69,'Tm','Thulium','168,9','lan',15,8], [70,'Yb','Ytterbium','173,0','lan',16,8], [71,'Lu','Lutécium','175,0','lan',17,8], [72,'Hf','Hafnium','178,5','tm',4,6],
  [73,'Ta','Tantale','180,9','tm',5,6], [74,'W','Tungstène','183,8','tm',6,6], [75,'Re','Rhénium','186,2','tm',7,6], [76,'Os','Osmium','190,2','tm',8,6], [77,'Ir','Iridium','192,2','tm',9,6], [78,'Pt','Platine','195,1','tm',10,6],
  [79,'Au','Or','197,0','tm',11,6], [80,'Hg','Mercure','200,6','tm',12,6], [81,'Tl','Thallium','204,4','post',13,6], [82,'Pb','Plomb','207,2','post',14,6], [83,'Bi','Bismuth','209,0','post',15,6], [84,'Po','Polonium','[209]','post',16,6],
  [85,'At','Astate','[210]','halogen',17,6], [86,'Rn','Radon','[222]','noble',18,6], [87,'Fr','Francium','[223]','alkali',1,7], [88,'Ra','Radium','[226]','alkaline',2,7], [89,'Ac','Actinium','[227]','act',3,9], [90,'Th','Thorium','232,0','act',4,9],
  [91,'Pa','Protactinium','231,0','act',5,9], [92,'U','Uranium','238,0','act',6,9], [93,'Np','Neptunium','[237]','act',7,9], [94,'Pu','Plutonium','[244]','act',8,9], [95,'Am','Américium','[243]','act',9,9], [96,'Cm','Curium','[247]','act',10,9],
  [97,'Bk','Berkélium','[247]','act',11,9], [98,'Cf','Californium','[251]','act',12,9], [99,'Es','Einsteinium','[252]','act',13,9], [100,'Fm','Fermium','[257]','act',14,9], [101,'Md','Mendélévium','[258]','act',15,9], [102,'No','Nobélium','[259]','act',16,9],
  [103,'Lr','Lawrencium','[266]','act',17,9], [104,'Rf','Rutherfordium','[267]','tm',4,7], [105,'Db','Dubnium','[268]','tm',5,7], [106,'Sg','Seaborgium','[269]','tm',6,7], [107,'Bh','Bohrium','[270]','tm',7,7], [108,'Hs','Hassium','[269]','tm',8,7],
  [109,'Mt','Meitnérium','[278]','unknown',9,7], [110,'Ds','Darmstadtium','[281]','unknown',10,7], [111,'Rg','Roentgenium','[282]','unknown',11,7], [112,'Cn','Copernicium','[285]','tm',12,7], [113,'Nh','Nihonium','[286]','post',13,7], [114,'Fl','Flérovium','[289]','post',14,7],
  [115,'Mc','Moscovium','[290]','post',15,7], [116,'Lv','Livermorium','[293]','post',16,7], [117,'Ts','Tennesse','[294]','halogen',17,7], [118,'Og','Oganesson','[294]','noble',18,7],
];

/** Family colour + French legend label per category code used in ELEMENTS. */
const CATEGORY: Record<string, { color: string; label: string }> = {
  alkali: { color: '#ff8a80', label: 'Métaux alcalins' },
  alkaline: { color: '#ffcc80', label: 'Métaux alcalino-terreux' },
  tm: { color: '#ffe082', label: 'Métaux de transition' },
  post: { color: '#c5e1a5', label: 'Métaux pauvres' },
  metalloid: { color: '#80cbc4', label: 'Métalloïdes' },
  nonmetal: { color: '#90caf9', label: 'Non-métaux' },
  halogen: { color: '#b39ddb', label: 'Halogènes' },
  noble: { color: '#f48fb1', label: 'Gaz nobles' },
  lan: { color: '#a5d6a7', label: 'Lanthanides' },
  act: { color: '#80deea', label: 'Actinides' },
  unknown: { color: '#e0e0e0', label: 'Propriétés inconnues' },
};

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const CELL = 64; // cell width
const CH = 66; // cell height
const OX = 44; // left margin (room for period numbers)
const OY = 70; // top margin (room for title + group numbers)
const GAP = 26; // gap between the main table and the f-block rows

const cellY = (gy: number) => OY + (gy <= 7 ? (gy - 1) * CH : 7 * CH + GAP + (gy - 8) * CH);
const cellX = (gx: number) => OX + (gx - 1) * CELL;

/** One element tile. */
function tile(z: number, sym: string, mass: string, cat: string, gx: number, gy: number): string {
  const x = cellX(gx);
  const y = cellY(gy);
  const fill = (CATEGORY[cat] ?? CATEGORY.unknown).color;
  return (
    `<g>` +
    `<rect x="${x}" y="${y}" width="${CELL - 3}" height="${CH - 3}" rx="4" fill="${fill}" stroke="#37474f" stroke-width="1"/>` +
    `<text x="${x + 5}" y="${y + 14}" font-size="11" fill="#263238">${z}</text>` +
    `<text x="${x + CELL - 6}" y="${y + 14}" font-size="9" fill="#455a64" text-anchor="end">${esc(mass)}</text>` +
    `<text x="${x + (CELL - 3) / 2}" y="${y + 42}" font-size="23" font-weight="700" fill="#1a1a1a" text-anchor="middle">${esc(sym)}</text>` +
    `</g>`
  );
}

/** A placeholder cell in the main grid pointing at the f-block rows below. */
function marker(text: string, color: string, gx: number, gy: number): string {
  const x = cellX(gx);
  const y = cellY(gy);
  return (
    `<rect x="${x}" y="${y}" width="${CELL - 3}" height="${CH - 3}" rx="4" fill="${color}" stroke="#37474f" stroke-width="1" stroke-dasharray="3 2"/>` +
    `<text x="${x + (CELL - 3) / 2}" y="${y + 40}" font-size="12" fill="#1a1a1a" text-anchor="middle">${text}</text>`
  );
}

/**
 * The whole table as a self-contained, coloured SVG string (no script, no external refs — safe to
 * inline and to pass through the figure sanitiser). Exact symbols, atomic numbers and standard
 * atomic weights; colour by family.
 */
export function periodicTableSvg(): string {
  const width = OX + 18 * CELL + 12;
  const height = cellY(9) + CH + 96; // room for the legend under the f-block
  const parts: string[] = [];

  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" font-family="Arial, sans-serif">`);
  parts.push(`<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`);
  parts.push(`<text x="${width / 2}" y="34" font-size="26" font-weight="700" fill="#1a1a1a" text-anchor="middle">Tableau Périodique des Éléments</text>`);

  // Group numbers 1–18 across the top.
  for (let g = 1; g <= 18; g++) {
    parts.push(`<text x="${cellX(g) + (CELL - 3) / 2}" y="${OY - 6}" font-size="11" fill="#607d8b" text-anchor="middle">${g}</text>`);
  }
  // Period numbers 1–7 down the left.
  for (let p = 1; p <= 7; p++) {
    parts.push(`<text x="${OX - 12}" y="${cellY(p) + (CH - 3) / 2 + 4}" font-size="11" fill="#607d8b" text-anchor="middle">${p}</text>`);
  }

  // Markers where the f-block is pulled out (group 3, periods 6 and 7).
  parts.push(marker('57–71', CATEGORY.lan.color, 3, 6));
  parts.push(marker('89–103', CATEGORY.act.color, 3, 7));

  for (const [z, sym, , mass, cat, gx, gy] of ELEMENTS) parts.push(tile(z, sym, mass, cat, gx, gy));

  // Legend, in reading order, wrapped under the table.
  const legendY = cellY(9) + CH + 20;
  const order = ['alkali', 'alkaline', 'tm', 'post', 'metalloid', 'nonmetal', 'halogen', 'noble', 'lan', 'act', 'unknown'];
  let lx = OX;
  let ly = legendY;
  for (const key of order) {
    const { color, label } = CATEGORY[key];
    const w = 16 + 7.2 * label.length + 22;
    if (lx + w > width - OX) {
      lx = OX;
      ly += 24;
    }
    parts.push(`<rect x="${lx}" y="${ly - 11}" width="14" height="14" rx="2" fill="${color}" stroke="#37474f" stroke-width="0.8"/>`);
    parts.push(`<text x="${lx + 20}" y="${ly}" font-size="12" fill="#263238">${esc(label)}</text>`);
    lx += w;
  }

  parts.push('</svg>');
  return parts.join('');
}
