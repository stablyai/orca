// Bun; argv[2] is a read-only OMP checkout. No model requests.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getAgentResumeArgv } from '../../src/shared/agent-session-resume.ts'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout path')
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-resume-locator-'))
process.env.HOME = join(scratch, 'home')
process.env.USERPROFILE = process.env.HOME
for (const key of [
  'OMP_CODING_AGENT_DIR',
  'PI_CODING_AGENT_DIR',
  'PI_CONFIG_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_FILES'
]) {
  delete process.env[key]
}
process.env.XDG_CONFIG_HOME = join(scratch, 'config')
process.env.XDG_DATA_HOME = join(scratch, 'data')
process.env.XDG_STATE_HOME = join(scratch, 'state')
const source = (name) =>
  pathToFileURL(join(resolve(process.argv[2]), 'packages/coding-agent/src', name)).href
const managers = []
try {
  await mkdir(process.env.HOME, { recursive: true })
  const { SessionManager } = await import(source('session/session-manager.ts'))
  const { Settings } = await import(source('config/settings.ts'))
  const { createSessionManager } = await import(source('main.ts'))
  const { parseArgs } = await import(source('cli/args.ts'))
  const cwd = join(scratch, 'folder workspace')
  await mkdir(cwd)
  const original = SessionManager.create(cwd, join(scratch, 'custom sessions'))
  managers.push(original)
  original.appendMessage({
    role: 'user',
    content: 'task in a custom session root',
    timestamp: Date.now()
  })
  await original.ensureOnDisk()
  await original.flush()
  const settings = await Settings.init({ cwd })
  await assert.rejects(
    createSessionManager({ resume: original.getSessionId() }, cwd, settings),
    /not found/
  )
  const direct = await createSessionManager({ resume: original.getSessionFile() }, cwd, settings)
  managers.push(direct)
  assert.equal(direct.getSessionId(), original.getSessionId())
  const argv = getAgentResumeArgv('omp', {
    key: 'session_id',
    id: original.getSessionId(),
    transcriptPath: original.getSessionFile()
  })
  assert.ok(argv)
  assert.equal(
    argv[2],
    original.getSessionFile(),
    'Orca must retain the recorded transcript locator'
  )
  const resumed = await createSessionManager(parseArgs(argv.slice(1)), cwd, settings)
  managers.push(resumed)
  assert.equal(resumed.getSessionId(), original.getSessionId())
  console.log(
    JSON.stringify({
      customRootUuidMisses: true,
      absolutePathResumes: true,
      generatedArgvResumes: true,
      modelCalls: 0
    })
  )
} finally {
  for (const manager of managers) {
    await manager?.close()
  }
  await rm(scratch, { recursive: true, force: true })
}
