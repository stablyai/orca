#!/usr/bin/env node
/**
 * Seed the curated Petdex starter pack into a live Orca userData tree.
 *
 * Usage:
 *   node tools/seed-petdex-pets.mjs [--user-data DIR] [--data-json PATH] ...
 *
 * Defaults (Linux fork):
 *   user-data  = ~/.config/orca
 *   data-json  = ~/.config/orca/profiles/local-default/orca-data.json
 *                (also patches ~/.config/orca/orca-data.json if present)
 *
 * Does not require Electron. Stops short of starting the app — stop orca-serve
 * / orca GUI first so the profile store is not rewritten mid-seed.
 */

import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile, copyFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO = join(__dirname, '..')

// --- inlined catalog (keep in sync with src/shared/petdex-catalog.ts) ---
const PETDEX_MANIFEST_URL = 'https://petdex.dev/api/manifest'
const PETDEX_STARTER_SLUGS = [
  'nous-girl',
  'strike-freedom',
  'gojo',
  'clank',
  'faye',
  'claw-crawler',
  'apupepe',
  'rubick',
  'spike',
  'mini-gandalf-the-grey',
  'teknium',
  'nezukocoder',
]
const PETDEX_STARTER_LABELS = {
  'nous-girl': 'Nous Girl',
  'strike-freedom': 'Strike Freedom Gundam',
  'gojo': 'Gojo',
  'clank': 'Clank',
  'faye': 'Faye',
  'claw-crawler': 'kuro-chan',
  'apupepe': 'Pepe',
  'rubick': 'Rubick',
  'spike': 'Spike',
  'mini-gandalf-the-grey': 'Mini Gandalf the Grey',
  'teknium': 'Teknium',
  'nezukocoder': 'NezukoCoder',
}
const PETDEX_DEFAULT_ACTIVE_SLUG = 'mini-gandalf-the-grey'
const MESH_DEFAULTS_DIR = join(REPO, 'resources', 'pets', 'mesh-defaults')


const CODEX_PET_FRAME = { width: 192, height: 208 }
function appStateDurations(frames, frameMs, finalMs) {
  return Array.from({ length: frames }, (_, i) => (i === frames - 1 ? finalMs : frameMs))
}
const CODEX_PET_ANIMATIONS = {
  idle: { row: 0, frames: 6, frameDurationsMs: [1680, 660, 660, 840, 840, 1920] },
  'running-right': { row: 1, frames: 8, frameDurationsMs: appStateDurations(8, 120, 220) },
  'running-left': { row: 2, frames: 8, frameDurationsMs: appStateDurations(8, 120, 220) },
  waving: { row: 3, frames: 4, frameDurationsMs: appStateDurations(4, 140, 280) },
  jumping: { row: 4, frames: 5, frameDurationsMs: appStateDurations(5, 140, 280) },
  failed: { row: 5, frames: 8, frameDurationsMs: appStateDurations(8, 140, 240) },
  waiting: { row: 6, frames: 6, frameDurationsMs: appStateDurations(6, 150, 260) },
  running: { row: 7, frames: 6, frameDurationsMs: appStateDurations(6, 120, 220) },
  review: { row: 8, frames: 6, frameDurationsMs: appStateDurations(6, 150, 280) }
}

function isPetdexAllowedUrl(url) {
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return false
    const host = u.hostname.toLowerCase()
    return host === 'petdex.dev' || host === 'assets.petdex.dev' || host.endsWith('.petdex.dev')
  } catch {
    return false
  }
}

function readUInt24LE(buffer, offset) {
  return buffer[offset] | (buffer[offset + 1] << 8) | (buffer[offset + 2] << 16)
}

function readWebpDimensionsFromBuffer(buffer) {
  if (
    buffer.byteLength < 20 ||
    buffer.toString('ascii', 0, 4) !== 'RIFF' ||
    buffer.toString('ascii', 8, 12) !== 'WEBP'
  ) {
    return null
  }
  let offset = 12
  while (offset + 8 <= buffer.byteLength) {
    const chunkType = buffer.toString('ascii', offset, offset + 4)
    const chunkSize = buffer.readUInt32LE(offset + 4)
    const dataOffset = offset + 8
    const dataEnd = dataOffset + chunkSize
    if (dataEnd > buffer.byteLength) return null
    if (chunkType === 'VP8X' && chunkSize >= 10) {
      return {
        width: readUInt24LE(buffer, dataOffset + 4) + 1,
        height: readUInt24LE(buffer, dataOffset + 7) + 1
      }
    }
    if (chunkType === 'VP8L' && chunkSize >= 5 && buffer[dataOffset] === 0x2f) {
      const b0 = buffer[dataOffset + 1]
      const b1 = buffer[dataOffset + 2]
      const b2 = buffer[dataOffset + 3]
      const b3 = buffer[dataOffset + 4]
      return {
        width: 1 + (((b1 & 0x3f) << 8) | b0),
        height: 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6))
      }
    }
    if (
      chunkType === 'VP8 ' &&
      chunkSize >= 10 &&
      buffer[dataOffset + 3] === 0x9d &&
      buffer[dataOffset + 4] === 0x01 &&
      buffer[dataOffset + 5] === 0x2a
    ) {
      const width = buffer.readUInt16LE(dataOffset + 6) & 0x3fff
      const height = buffer.readUInt16LE(dataOffset + 8) & 0x3fff
      return width > 0 && height > 0 ? { width, height } : null
    }
    offset = dataEnd + (chunkSize % 2)
  }
  return null
}

function parseArgs(argv) {
  const out = {
    userData: join(homedir(), '.config', 'orca'),
    dataJsons: [],
    setActive: true,
    dryRun: false
  }
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--user-data') out.userData = argv[++i]
    else if (a === '--data-json') out.dataJsons.push(argv[++i])
    else if (a === '--no-set-active') out.setActive = false
    else if (a === '--dry-run') out.dryRun = true
    else if (a === '--help' || a === '-h') {
      console.log(`Usage: node tools/seed-petdex-pets.mjs [--user-data DIR] [--data-json PATH]...`)
      process.exit(0)
    }
  }
  if (out.dataJsons.length === 0) {
    out.dataJsons = [
      join(out.userData, 'profiles', 'local-default', 'orca-data.json'),
      join(out.userData, 'orca-data.json')
    ]
  }
  return out
}

async function main() {
  const opts = parseArgs(process.argv)
  const customDir = join(opts.userData, 'sidekicks', 'custom')
  console.log(`[seed] userData=${opts.userData}`)
  console.log(`[seed] customDir=${customDir}`)
  console.log(`[seed] starter slugs=${PETDEX_STARTER_SLUGS.length}`)

  const manRes = await fetch(PETDEX_MANIFEST_URL, {
    headers: { 'User-Agent': 'orca-petdex-seed/1.0', Accept: 'application/json' },
    redirect: 'follow'
  })
  if (!manRes.ok) throw new Error(`manifest HTTP ${manRes.status}`)
  const manifest = await manRes.json()
  const bySlug = new Map((manifest.pets || []).map((p) => [p.slug, p]))
  console.log(`[seed] manifest total=${manifest.total ?? manifest.pets?.length}`)

  const installed = []
  const skipped = []

  for (const slug of PETDEX_STARTER_SLUGS) {
    const localSheet = join(MESH_DEFAULTS_DIR, slug, 'spritesheet.webp')
    let entry = bySlug.get(slug)
    if (!entry && existsSync(localSheet)) {
      entry = {
        slug,
        displayName: PETDEX_STARTER_LABELS[slug] || slug,
        spritesheetUrl: 'https://assets.petdex.dev/local-bundled/' + slug
      }
    }
    if (!entry) {
      skipped.push({ slug, reason: 'not in manifest and no bundled sheet' })
      console.warn(`[seed] SKIP ${slug}: not in manifest and no bundled sheet`)
      continue
    }
    if (!existsSync(localSheet) && !isPetdexAllowedUrl(entry.spritesheetUrl)) {
      skipped.push({ slug, reason: 'disallowed host' })
      continue
    }
    if (opts.dryRun) {
      console.log(`[seed] dry-run would install ${slug}`)
      continue
    }
    try {
      process.stdout.write(`[seed] ${slug}… `)
      const localSheet = join(MESH_DEFAULTS_DIR, slug, 'spritesheet.webp')
      let buf
      if (existsSync(localSheet)) {
        buf = await readFile(localSheet)
        process.stdout.write('(bundled) ')
      } else {
        const res = await fetch(entry.spritesheetUrl, {
          headers: { 'User-Agent': 'orca-petdex-seed/1.0' },
          redirect: 'follow'
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        buf = Buffer.from(await res.arrayBuffer())
      }
      const dims = readWebpDimensionsFromBuffer(buf)
      if (!dims) throw new Error('bad webp dims')
      if (dims.width % CODEX_PET_FRAME.width || dims.height % CODEX_PET_FRAME.height) {
        throw new Error(`grid ${dims.width}x${dims.height}`)
      }
      const columns = dims.width / CODEX_PET_FRAME.width
      const rows = dims.height / CODEX_PET_FRAME.height
      if (columns < 8 || rows < 9) throw new Error(`grid cols=${columns} rows=${rows}`)

      const id = randomUUID()
      const destDir = join(customDir, id)
      const tmpDir = `${destDir}.tmp`
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
      await mkdir(tmpDir, { recursive: true })
      await writeFile(join(tmpDir, 'spritesheet.webp'), buf)
      await writeFile(
        join(tmpDir, 'pet.json'),
        JSON.stringify(
          {
            id: entry.slug,
            displayName: entry.displayName,
            description: `Petdex ${entry.kind || 'pet'}${entry.submittedBy ? ` by ${entry.submittedBy}` : ''}`,
            spritesheetPath: 'spritesheet.webp'
          },
          null,
          2
        ) + '\n'
      )
      await writeFile(
        join(tmpDir, 'petdex-provenance.json'),
        JSON.stringify(
          {
            source: 'petdex',
            slug: entry.slug,
            spritesheetUrl: entry.spritesheetUrl,
            sheetSha256: createHash('sha256').update(buf).digest('hex'),
            installedAt: new Date().toISOString()
          },
          null,
          2
        ) + '\n'
      )
      await mkdir(customDir, { recursive: true })
      await rename(tmpDir, destDir)

      const pet = {
        id,
        label: String(PETDEX_STARTER_LABELS[slug] || entry.displayName || slug).slice(0, 40),
        fileName: 'spritesheet.webp',
        mimeType: 'image/webp',
        kind: 'bundle',
        sprite: {
          frameWidth: CODEX_PET_FRAME.width,
          frameHeight: CODEX_PET_FRAME.height,
          columns,
          rows,
          sheetWidth: dims.width,
          sheetHeight: dims.height,
          fps: 8,
          defaultAnimation: 'idle',
          animations: { ...CODEX_PET_ANIMATIONS }
        }
      }
      pet._slug = slug
      installed.push(pet)
      console.log(`ok → ${id.slice(0, 8)}… ${dims.width}x${dims.height}`)
    } catch (err) {
      skipped.push({ slug, reason: err.message || String(err) })
      console.warn(`FAIL: ${err.message || err}`)
    }
  }

  if (opts.dryRun) {
    console.log('[seed] dry-run complete')
    return
  }

  // Patch orca-data.json ui.customPets (+ enable experimental pet)
  for (const dataPath of opts.dataJsons) {
    if (!existsSync(dataPath)) {
      console.warn(`[seed] data json missing, skip: ${dataPath}`)
      continue
    }
    const bak = `${dataPath}.pre-petdex-seed`
    if (!existsSync(bak)) {
      await copyFile(dataPath, bak)
    }
    const data = JSON.parse(await readFile(dataPath, 'utf8'))
    data.settings = data.settings || {}
    data.settings.experimentalPet = true
    data.settings.petBubbleEnabled = true
    data.ui = data.ui || {}
    const prev = Array.isArray(data.ui.customPets) ? data.ui.customPets : []
    // Replace prior petdex-seeded bundles that match our labels? Keep all, append new.
    // Dedupe by label for re-runs of the same seed.
    const labels = new Set(installed.map((p) => p.label))
    const kept = prev.filter((p) => !labels.has(p.label) || p.kind !== 'bundle')
    data.ui.customPets = [...kept, ...installed.map(({ _slug, ...rest }) => rest)]
    if (opts.setActive && installed.length) {
      const preferred = installed.find((p) => p._slug === PETDEX_DEFAULT_ACTIVE_SLUG) || installed[0]
      data.ui.petId = preferred.id
      data.ui.petVisible = true
    }
    await writeFile(dataPath, JSON.stringify(data, null, 2) + '\n')
    console.log(
      `[seed] wrote ${dataPath}: customPets=${data.ui.customPets.length} active=${data.ui.petId}`
    )
  }

  console.log(`[seed] done installed=${installed.length} skipped=${skipped.length}`)
  if (skipped.length) {
    console.log('[seed] skipped detail:', JSON.stringify(skipped, null, 2))
  }
  if (installed.length < 10) {
    process.exitCode = 2
    console.error('[seed] fewer than 10 pets installed — treat as failure')
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
