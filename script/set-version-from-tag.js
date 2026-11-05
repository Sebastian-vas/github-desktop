// Sets the app version from a release tag: v3.4.14-linux1-ai1 -> 3.4.14-linux1-ai1
const fs = require('fs')
const path = require('path')

const tag = process.argv[2] || ''
const version = tag.replace(/^v/, '')
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/.test(version)) {
  console.error(
    `"${tag}" is not a valid version tag (expected e.g. v3.4.14-linux1-ai1)`
  )
  process.exit(1)
}

const file = path.join(__dirname, '..', 'app', 'package.json')
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'))
pkg.version = version
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n')
console.log(`Version set to ${version}`)
