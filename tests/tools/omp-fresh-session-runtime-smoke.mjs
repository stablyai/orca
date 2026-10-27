// Bun, with a read-only OMP source checkout as argv[2]. No model requests.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { OMP_FRESH_CONFIG_SOURCE } from '../../src/shared/omp-fresh-launch.ts'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout path')
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-fresh-proof-'))
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
process.env.XDG_CONFIG_HOME = join(scratch, 'xdg-config')
process.env.XDG_DATA_HOME = join(scratch, 'xdg-data')
process.env.XDG_STATE_HOME = join(scratch, 'xdg-state')
process.env.OMP_CODING_AGENT_DIR = join(scratch, 'agent')
delete process.env.PI_CONFIG_FILES
const source = (path) =>
  pathToFileURL(join(resolve(process.argv[2]), 'packages/coding-agent/src', path)).href
const managers = []
try {
  await mkdir(process.env.HOME, { recursive: true })
  const { SessionManager } = await import(source('session/session-manager.ts'))
  const { Settings, resetSettingsForTest } = await import(source('config/settings.ts'))
  const { createSessionManager } = await import(source('main.ts'))
  const cwd = join(scratch, 'project')
  await mkdir(cwd)
  const previous = SessionManager.create(cwd)
  managers.push(previous)
  previous.appendMessage({ role: 'user', content: 'previous task', timestamp: Date.now() })
  await previous.ensureOnDisk()
  await previous.flush()
  const config = join(scratch, 'fresh.yml')
  const userConfig = join(scratch, 'user.yml')
  await writeFile(config, OMP_FRESH_CONFIG_SOURCE)
  await writeFile(userConfig, 'autoResume: true\n')
  const settings = await Settings.init({ cwd, configFiles: [userConfig] })
  const resumed = await createSessionManager({}, cwd, settings)
  managers.push(resumed)
  assert.equal(resumed.getSessionId(), previous.getSessionId())
  resetSettingsForTest()
  const freshSettings = await Settings.init({ cwd, configFiles: [userConfig, config] })
  assert.equal(freshSettings.get('autoResume'), false)
  assert.equal(settings.get('autoResume'), true)
  const defaultSelection = await createSessionManager({}, cwd, freshSettings)
  assert.equal(defaultSelection, undefined, 'SDK creates a fresh session after undefined selection')
  const fresh = SessionManager.create(cwd)
  managers.push(fresh)
  assert.notEqual(fresh.getSessionId(), previous.getSessionId())
  assert.equal(fresh.getSessionDir(), previous.getSessionDir())
  const explicit = await createSessionManager(
    { resume: previous.getSessionFile() },
    cwd,
    freshSettings
  )
  managers.push(explicit)
  assert.equal(explicit.getSessionId(), previous.getSessionId())
  console.log(
    JSON.stringify({
      platform: process.platform,
      autoResumeReproduced: true,
      freshSelected: true,
      storageDirectoryPreserved: true,
      explicitResumePreserved: true,
      modelCalls: 0,
      scope:
        'Actual OMP Settings overlays, persistent SessionManager and createSessionManager; no rendered UI'
    })
  )
} finally {
  for (const manager of managers) {
    await manager?.close()
  }
  await rm(scratch, { recursive: true, force: true })
}
