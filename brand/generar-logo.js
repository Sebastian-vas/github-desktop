// Logo for Gitflow in the style of Flowless' division logos
// (insumos/divisions/logos/generar.py): gradient disc, open ring, name on the
// arc in Montserrat SemiBold outlines, white symbol; normal / oscuro / favicon.
const fs = require('fs')
const path = require('path')
const opentype = require('opentype.js')
const { Resvg } = require('@resvg/resvg-js')

const OUT = process.argv[2]
const WORD = process.env.WORD || 'GITFLOW'
const C0 = process.env.C0 || '#7c3aed'
const C1 = process.env.C1 || '#2e1065'
fs.mkdirSync(OUT, { recursive: true })

const font = opentype.loadSync(
  process.env.MONTSERRAT || `${process.env.HOME}/Documents/GitHub/flowless/resources/fonts/montserrat/Montserrat-SemiBold.ttf`
)
const UPM = font.unitsPerEm
const CAPH = font.tables.os2.sCapHeight

// Same measures as generar.py
const C = 256, R = 256
const RING_R = 0.836 * R, RING_W = 0.026 * R
const CAP_IN = 0.772 * R, CAP_OUT = 0.925 * R
const FS = (CAP_OUT - CAP_IN) / (CAPH / UPM)
const TRACK = 0.32, MAXHALF = 51

const rad = d => (d * Math.PI) / 180
const deg = r => (r * 180) / Math.PI

function textPaths(word) {
  const rmid = (CAP_IN + CAP_OUT) / 2
  let fsz = FS
  const glyphs = [...word].map(ch => font.charToGlyph(ch))
  const raw = glyphs.reduce((s, g) => s + g.advanceWidth, 0) / UPM
  const maxlen0 = rad(MAXHALF) * 2 * rmid
  const MINTR = 0.14
  if (raw * fsz + MINTR * fsz * (word.length - 1) > maxlen0) {
    fsz = maxlen0 / (raw + MINTR * (word.length - 1))
  }
  const s = fsz / UPM
  const adv = glyphs.map(g => g.advanceWidth * s)
  let tr = TRACK * fsz
  const maxlen = rad(MAXHALF) * 2 * rmid
  const sumAdv = adv.reduce((a, b) => a + b, 0)
  if (sumAdv + tr * (word.length - 1) > maxlen) {
    tr = (maxlen - sumAdv) / (word.length - 1)
  }
  const total = sumAdv + tr * (word.length - 1)
  const capd = (CAPH / UPM) * fsz
  const rb = rmid + capd / 2 // heads towards the centre
  let pos = -total / 2
  const out = []
  glyphs.forEach((g, i) => {
    const w = adv[i]
    const mid = pos + w / 2
    const a = -(mid / rb)
    const phi = deg(a) - 90
    const x = C + rb * Math.cos(a)
    const y = C + rb * Math.sin(a)
    const d = g.getPath(-w / 2, 0, fsz).toPathData(3)
    out.push(
      `<path transform="translate(${x.toFixed(3)},${y.toFixed(3)}) rotate(${phi.toFixed(3)})" d="${d}"/>`
    )
    pos += w + tr
  })
  const g0 = glyphs[0], g1 = glyphs[glyphs.length - 1]
  const ink = total - (g0.xMin || 0) * s - (g1.advanceWidth - (g1.xMax || 0)) * s
  const half = deg(ink / 2 / rb)
  return { paths: out.join(''), half }
}

function ring(half) {
  const gap = half + 8.8
  const a0 = rad(gap), a1 = rad(360 - gap)
  const x0 = C + RING_R * Math.cos(a0), y0 = C + RING_R * Math.sin(a0)
  const x1 = C + RING_R * Math.cos(a1), y1 = C + RING_R * Math.sin(a1)
  return `<path d="M${x0.toFixed(3)},${y0.toFixed(3)} A${RING_R.toFixed(3)},${RING_R.toFixed(3)} 0 1 1 ${x1.toFixed(3)},${y1.toFixed(3)}" fill="none" stroke-width="${RING_W.toFixed(3)}" stroke-linecap="butt"/>`
}

const grad = (id, c0, c1) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="512" y2="512" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="${c0}"/><stop offset="1" stop-color="${c1}"/></linearGradient>`

// The symbol: a git graph (trunk, a branch, three nodes) with an AI sparkle.
// Drawn in its own 512 box; `paint` is the fill/stroke colour.
function symbol(paint, holeFill, compact = false) {
  const sw = compact ? 38 : 30 // stroke width
  const nr = 27 // node radius
  const trunkX = 196
  const top = 150, bottom = 372
  const branch = { x: 300, y: 196 }
  const node = (cx, cy) =>
    `<circle cx="${cx}" cy="${cy}" r="${nr}" fill="${holeFill}" stroke="${paint}" stroke-width="${sw}"/>`
  // 4-point sparkle with concave sides
  const sx = 314, sy = 330, sR = 50, sr = 11
  const sparkle =
    `M${sx},${sy - sR} ` +
    `Q${sx + sr},${sy - sr} ${sx + sR},${sy} ` +
    `Q${sx + sr},${sy + sr} ${sx},${sy + sR} ` +
    `Q${sx - sr},${sy + sr} ${sx - sR},${sy} ` +
    `Q${sx - sr},${sy - sr} ${sx},${sy - sR} Z`
  const sx2 = 360, sy2 = 268, sR2 = 20, sr2 = 5
  const sparkle2 =
    `M${sx2},${sy2 - sR2} ` +
    `Q${sx2 + sr2},${sy2 - sr2} ${sx2 + sR2},${sy2} ` +
    `Q${sx2 + sr2},${sy2 + sr2} ${sx2},${sy2 + sR2} ` +
    `Q${sx2 - sr2},${sy2 + sr2} ${sx2 - sR2},${sy2} ` +
    `Q${sx2 - sr2},${sy2 - sr2} ${sx2},${sy2 - sR2} Z`
  return (
    `<g fill="none" stroke="${paint}" stroke-width="${sw}" stroke-linecap="round">` +
    `<path d="M${trunkX},${top + nr} L${trunkX},${bottom - nr}"/>` +
    `<path d="M${branch.x},${branch.y + nr} C${branch.x},${branch.y + 95} ${trunkX},${branch.y + 70} ${trunkX},${branch.y + 150}"/>` +
    `</g>` +
    node(trunkX, top) +
    node(trunkX, bottom) +
    node(branch.x, branch.y) +
    `<path d="${sparkle}" fill="${paint}"/>` +
    (compact ? '' : `<path d="${sparkle2}" fill="${paint}"/>`)
  )
}

// Bounding box of the symbol, for centring it in the favicon
const SYM = { x0: 196 - 27 - 19, y0: 150 - 27 - 19, x1: 314 + 50, y1: 372 + 27 + 19 }

function build() {
  const { paths: tx, half } = textPaths(WORD)
  const rg = ring(half)
  const hdr = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512" role="img" aria-label="${WORD}"><title>${WORD}</title>`

  const normal =
    hdr +
    `<defs>${grad('g-ghd', C0, C1)}</defs>` +
    `<circle cx="256" cy="256" r="256" fill="url(#g-ghd)"/>` +
    `<g stroke="#fff">${rg}</g>` +
    `<g fill="#fff">${tx}</g>` +
    `<g>${symbol('#fff', 'none')}</g></svg>`

  const dark =
    hdr +
    `<defs>${grad('g-ghd-d', C0, C1)}</defs>` +
    `<circle cx="256" cy="256" r="256" fill="#fff"/>` +
    `<g stroke="url(#g-ghd-d)">${rg}</g>` +
    `<g fill="url(#g-ghd-d)">${tx}</g>` +
    `<g>${symbol('url(#g-ghd-d)', 'none')}</g></svg>`

  // Favicon: the symbol alone, centred and bigger so it reads at 16 px
  const w = SYM.x1 - SYM.x0, h = SYM.y1 - SYM.y0
  const scale = (1.3 * R) / Math.max(w, h)
  const cx = (SYM.x0 + SYM.x1) / 2, cy = (SYM.y0 + SYM.y1) / 2
  const fav =
    hdr +
    `<defs>${grad('g-ghd-f', C0, C1)}</defs>` +
    `<circle cx="256" cy="256" r="256" fill="url(#g-ghd-f)"/>` +
    `<g transform="translate(256,256) scale(${scale.toFixed(4)}) translate(${-cx},${-cy})">${symbol('#fff', 'none', true)}</g></svg>`

  for (const [name, svg] of [['normal', normal], ['oscuro', dark], ['favicon', fav]]) {
    fs.writeFileSync(path.join(OUT, `${name}.svg`), svg)
    for (const size of [512]) {
      const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render().asPng()
      fs.writeFileSync(path.join(OUT, `${name}.png`), png)
    }
  }
  // A small preview of the favicon at real sizes
  for (const size of [16, 32, 64]) {
    const png = new Resvg(fav, { fitTo: { mode: 'width', value: size } }).render().asPng()
    fs.writeFileSync(path.join(OUT, `favicon-${size}.png`), png)
  }
  console.log('ok, arc half-span', half.toFixed(1))
}

build()
