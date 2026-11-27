// Gives a repackaged build its own app.asar: rewrites the app version inside the archive's
// package.json in place (same length, so the archive layout is unchanged). Usage:
// node stamp-asar.mjs <app.asar> <fromVersion> <toVersion>
import { readFileSync, writeFileSync } from 'node:fs'

const [asarPath, from, to] = process.argv.slice(2)
if (!asarPath || !from || !to || from.length !== to.length) {
  throw new Error('usage: stamp-asar.mjs <app.asar> <from> <to> (versions of equal length)')
}
const bytes = readFileSync(asarPath)
let count = 0
for (const spacing of ['"version":"', '"version": "']) {
  const needle = Buffer.from(`${spacing}${from}"`)
  const replacement = Buffer.from(`${spacing}${to}"`)
  for (let at = bytes.indexOf(needle); at !== -1; at = bytes.indexOf(needle, at + needle.length)) {
    replacement.copy(bytes, at)
    count++
  }
}
if (count === 0) {
  throw new Error(`no "version": "${from}" in ${asarPath}`)
}
writeFileSync(asarPath, bytes)
console.log(`stamped ${count} version field(s) ${from} -> ${to} in ${asarPath}`)
