import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout')

const orcaRoot = fileURLToPath(new URL('../../', import.meta.url))

const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-history-title-'))

process.env.HOME = join(scratch, 'home')

process.env.USERPROFILE = process.env.HOME

for (const [key, value] of Object.entries({
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache'
})) {
  process.env[key] = join(scratch, value)
}

for (const key of [
  'OMP_CODING_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_DIR',
  'PI_CONFIG_FILES'
]) {
  delete process.env[key]
}

await mkdir(process.env.HOME, { recursive: true })

const source = (root, path) => pathToFileURL(join(resolve(root), path)).href

const { SessionManager } = await import(
  source(process.argv[2], 'packages/coding-agent/src/session/session-manager.ts')
)

const { parseMessageGraphSessionFile } = await import(
  source(orcaRoot, 'src/main/ai-vault/session-scanner-graph-parsers.ts')
)

const { createSessionParseStats, parseAgentSessionFileCached } = await import(
  source(orcaRoot, 'src/main/ai-vault/session-scanner-parse-cache.ts')
)

const stats = createSessionParseStats()

const manager = SessionManager.create(scratch, join(scratch, 'sessions'))

try {
  manager.appendMessage({ role: 'user', content: 'Original first prompt', timestamp: Date.now() })
  await manager.ensureOnDisk()
  await manager.flush()

  const candidate = async () => {
    const details = await stat(manager.getSessionFile())

    return {
      agent: 'omp',
      codexHome: null,
      file: {
        path: manager.getSessionFile(),
        mtimeMs: details.mtimeMs,
        modifiedAt: details.mtime.toISOString(),
        sizeBytes: details.size
      }
    }
  }

  const initial = await parseAgentSessionFileCached(await candidate(), process.platform, stats)
  assert.equal(initial.title, 'Original first prompt')
  await manager.setSessionName('Explicit renamed conversation', 'user')
  await manager.flush()
  const path = manager.getSessionFile()
  const details = await stat(path)

  const parsed = await parseMessageGraphSessionFile(
    'omp',
    { path, mtimeMs: details.mtimeMs, modifiedAt: details.mtime.toISOString() },
    process.platform
  )

  const refreshed = await parseAgentSessionFileCached(await candidate(), process.platform, stats)
  assert.equal(parsed?.title, manager.getSessionName())
  assert.equal(refreshed?.title, manager.getSessionName())
  assert.equal(stats.fullParses, 1)
  assert.equal(stats.incremental, 1)
  assert.equal(initial.title, 'Original first prompt')
  const reused = await parseAgentSessionFileCached(await candidate(), process.platform, stats)
  assert.equal(reused, refreshed)
  console.log(
    JSON.stringify({
      actualOmpPersistence: true,
      renamedTitlePreserved: true,
      cachedRenamePreserved: true,
      unchangedSnapshotReused: true,
      fullParses: stats.fullParses,
      incrementalParses: stats.incremental,
      modelCalls: 0
    })
  )
} finally {
  await manager.close()
  await rm(scratch, { recursive: true, force: true })
}
