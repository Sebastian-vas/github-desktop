// Generates the app icons from the logo (brand/logo/*.svg):
//
//   app/static/linux/logos/{32..1024}.png   Linux window, menus and packages
//   app/static/logos/icon-logo.ico          Windows executable and installer
//   app/static/logos/icon-logo.icns         macOS app bundle
//   app/static/common/*logo-64x64@2x.png    "About GitHub Desktop"
//
// Like Flowless' DivisionLogo, sizes under 80 px use the favicon variant
// (the name on the arc can't be read that small); bigger ones use `normal`.
//
// Usage (with opentype.js and @resvg/resvg-js installed, see README.md):
//   node brand/generar-iconos.js
const fs = require('fs')
const path = require('path')
const { Resvg } = require('@resvg/resvg-js')

const ROOT = path.resolve(__dirname, '..')
const LOGO = path.join(__dirname, 'logo')
const normal = fs.readFileSync(path.join(LOGO, 'normal.svg'), 'utf8')
const favicon = fs.readFileSync(path.join(LOGO, 'favicon.svg'), 'utf8')

/** The icon as a PNG of the given size */
function png(size) {
  const svg = size < 80 ? favicon : normal
  return new Resvg(svg, { fitTo: { mode: 'width', value: size } })
    .render()
    .asPng()
}

function write(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, data)
  console.log(`${path.relative(ROOT, file)} (${data.length} bytes)`)
}

// Linux
for (const size of [32, 64, 128, 256, 512, 1024]) {
  write(
    path.join(ROOT, 'app/static/linux/logos', `${size}x${size}.png`),
    png(size)
  )
}

// Windows .ico: PNG-compressed entries (supported since Windows Vista)
function ico(sizes) {
  const images = sizes.map(png)
  const header = Buffer.alloc(6 + 16 * sizes.length)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(sizes.length, 4)
  let offset = header.length
  sizes.forEach((size, i) => {
    const entry = 6 + 16 * i
    header.writeUInt8(size >= 256 ? 0 : size, entry) // 0 means 256
    header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
    header.writeUInt8(0, entry + 2) // palette
    header.writeUInt8(0, entry + 3) // reserved
    header.writeUInt16LE(1, entry + 4) // colour planes
    header.writeUInt16LE(32, entry + 6) // bits per pixel
    header.writeUInt32LE(images[i].length, entry + 8)
    header.writeUInt32LE(offset, entry + 12)
    offset += images[i].length
  })
  return Buffer.concat([header, ...images])
}
write(
  path.join(ROOT, 'app/static/logos/icon-logo.ico'),
  ico([16, 24, 32, 48, 64, 128, 256])
)

// macOS .icns: PNG entries by OSType
function icns(entries) {
  const chunks = entries.map(([type, size]) => {
    const data = png(size)
    const head = Buffer.alloc(8)
    head.write(type, 0, 'ascii')
    head.writeUInt32BE(data.length + 8, 4)
    return Buffer.concat([head, data])
  })
  const body = Buffer.concat(chunks)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}
write(
  path.join(ROOT, 'app/static/logos/icon-logo.icns'),
  icns([
    ['icp4', 16],
    ['icp5', 32],
    ['icp6', 64],
    ['ic07', 128],
    ['ic08', 256],
    ['ic09', 512],
    ['ic10', 1024], // 512@2x
    ['ic11', 32], // 16@2x
    ['ic12', 64], // 32@2x
    ['ic13', 256], // 128@2x
    ['ic14', 512], // 256@2x
  ])
)

// "About GitHub Desktop" (64 px shown at 2x)
const about = png(128)
write(path.join(ROOT, 'app/static/common/logo-64x64@2x.png'), about)
write(path.join(ROOT, 'app/static/common/windows-logo-64x64@2x.png'), about)
