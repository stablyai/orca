// Regenerates the shipped-schema orchestration fixtures. See README.md before running: a
// regenerated fixture is a change to what "the shipped state" means, not a refresh.
//
// For each release tag it checks the tag out into a throwaway detached worktree, bundles
// populate-fixture.mjs against THAT tag's TypeScript, runs it, and copies the resulting SQLite
// file next to this script. Nothing here ever touches the current worktree's checkout.
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { build } from 'esbuild'

const FIXTURE_DIR = import.meta.dirname
const REPO_ROOT = join(FIXTURE_DIR, '..', '..', '..')

/**
 * The OrchestrationDb call shapes that differ between tags. Held as data so the diff of a new
 * entry is the API drift itself; populate-fixture.mjs asserts the row it wrote, so a wrong
 * entry fails the generator instead of silently writing a different fixture.
 */
const TAGS = [
  { tag: 'v1.4.180', dispatchArguments: 'positional', attachmentCarriesRunId: false },
  { tag: 'v1.4.190', dispatchArguments: 'positional', attachmentCarriesRunId: false },
  { tag: 'v1.4.198', dispatchArguments: 'params', attachmentCarriesRunId: false },
  { tag: 'v1.4.199', dispatchArguments: 'params', attachmentCarriesRunId: true }
]

/**
 * Two databases per tag, because the same release wrote two on-disk states that migrate down
 * different paths. With unbound direct mail, tags up to v1.4.198 file it under the legacy Run and
 * the skew probe replays the chain from the v6 floor. Without it, the stored stamp is trusted and
 * only the tail migrations run — the path most users are actually on.
 */
const VARIANTS = [
  { variant: 'unbound-mail', suffix: '', includeUnboundDirectMail: true },
  { variant: 'no-unbound-mail', suffix: '-no-unbound-mail', includeUnboundDirectMail: false }
]

function git(args, cwd = REPO_ROOT) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout.trim()
}

function removeWorktree(path) {
  spawnSync('git', ['worktree', 'remove', '--force', path], { cwd: REPO_ROOT, windowsHide: true })
  rmSync(path, { recursive: true, force: true })
  git(['worktree', 'prune'])
}

async function populateAtTag({ tag, dispatchArguments, attachmentCarriesRunId }) {
  const worktree = join(tmpdir(), `orca-fixture-${tag}`)
  const scratch = join(tmpdir(), `orca-fixture-scratch-${tag}`)
  removeWorktree(worktree)
  rmSync(scratch, { recursive: true, force: true })
  mkdirSync(scratch, { recursive: true })
  git(['worktree', 'add', '--detach', worktree, tag])
  try {
    // Reading the tag's TypeScript needs the current install; every tag in TAGS uses node:sqlite,
    // so there is no native module to rebuild. A tag that predates that would need its own install.
    symlinkSync(join(REPO_ROOT, 'node_modules'), join(worktree, 'node_modules'), 'junction')
    const populateInTag = join(worktree, 'tests', 'fixtures', 'orchestration-db')
    mkdirSync(populateInTag, { recursive: true })
    copyFileSync(
      join(FIXTURE_DIR, 'populate-fixture.mjs'),
      join(populateInTag, 'populate-fixture.mjs')
    )
    const bundle = join(scratch, 'populate.mjs')
    await build({
      entryPoints: [join(populateInTag, 'populate-fixture.mjs')],
      bundle: true,
      platform: 'node',
      format: 'esm',
      packages: 'external',
      absWorkingDir: worktree,
      outfile: bundle,
      logLevel: 'warning'
    })
    const commit = git(['rev-list', '-n', '1', tag])
    const written = []
    for (const { variant, suffix, includeUnboundDirectMail } of VARIANTS) {
      const dbPath = join(scratch, `orchestration-${variant}.db`)
      const expectedPath = join(scratch, `expected-${variant}.json`)
      const populateShape = { dispatchArguments, attachmentCarriesRunId, includeUnboundDirectMail }
      const run = spawnSync(
        process.execPath,
        [bundle, dbPath, JSON.stringify(populateShape), expectedPath],
        { cwd: worktree, encoding: 'utf8', windowsHide: true }
      )
      if (run.status !== 0) {
        throw new Error(`populate ${variant} at ${tag} failed: ${run.stderr || run.stdout}`)
      }
      const expected = JSON.parse(readFileSync(expectedPath, 'utf8'))
      const file = `${tag}${suffix}.sqlite`
      const target = join(FIXTURE_DIR, file)
      copyFileSync(dbPath, target)
      // OrchestrationDb hardens its file to 0600; a checkout produces 0644, so match the checkout.
      chmodSync(target, 0o644)
      written.push({
        tag,
        variant,
        file,
        commit,
        userVersion: expected.userVersion,
        populateShape,
        sha256: createHash('sha256').update(readFileSync(target)).digest('hex'),
        expected: {
          runIds: expected.runIds,
          taskIds: expected.taskIds,
          dispatchIds: expected.dispatchIds,
          messages: expected.messages,
          legacyAdoptionsCount: expected.legacyAdoptionsCount,
          attachments: expected.attachments,
          tableRowCounts: expected.tableRowCounts
        }
      })
    }
    return written
  } finally {
    removeWorktree(worktree)
    rmSync(scratch, { recursive: true, force: true })
  }
}

const requested = process.argv.slice(2)
const selected = requested.length ? TAGS.filter((entry) => requested.includes(entry.tag)) : TAGS
if (selected.length !== (requested.length || TAGS.length)) {
  throw new Error(`Unknown tag in ${requested.join(', ')}`)
}
const fixtures = []
for (const entry of selected) {
  process.stdout.write(`populating ${entry.tag}\n`)
  fixtures.push(...(await populateAtTag(entry)))
}
const manifestPath = join(FIXTURE_DIR, 'manifest.json')
const existing = requested.length
  ? JSON.parse(readFileSync(manifestPath, 'utf8')).fixtures.filter(
      (entry) => !requested.includes(entry.tag)
    )
  : []
const merged = [...existing, ...fixtures].sort((left, right) => left.file.localeCompare(right.file))
writeFileSync(manifestPath, `${JSON.stringify({ fixtures: merged }, null, 2)}\n`)
process.stdout.write(`wrote ${manifestPath}\n`)
