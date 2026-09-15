// Bun; argv[2] is a read-only OMP checkout. No model requests.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildAiVaultResumeCommand } from '../../src/shared/ai-vault-resume-command.ts'
import { tokenizeStartupCommand } from '../../src/shared/tui-agent-startup-shell.ts'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout path')

const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-child-resume-'))

process.env.HOME = join(scratch, 'home')

process.env.USERPROFILE = process.env.HOME

process.env.XDG_CONFIG_HOME = join(scratch, 'config')

process.env.XDG_DATA_HOME = join(scratch, 'data')

process.env.XDG_STATE_HOME = join(scratch, 'state')

process.env.PI_CODING_AGENT_DIR = join(scratch, 'agent')

delete process.env.OMP_CODING_AGENT_DIR

delete process.env.PI_CONFIG_DIR

delete process.env.OMP_PROFILE

delete process.env.PI_PROFILE

delete process.env.PI_CONFIG_FILES

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
  const parent = SessionManager.create(cwd)
  managers.push(parent)
  parent.appendMessage({ role: 'user', content: 'coordinate work', timestamp: Date.now() })
  await parent.ensureOnDisk()
  await parent.flush()
  const child = SessionManager.create(cwd, parent.getSessionFile().replace(/\.jsonl$/, ''))
  managers.push(child)
  child.appendMessage({ role: 'user', content: 'child task', timestamp: Date.now() })
  await child.ensureOnDisk()
  await child.flush()
  const grandchild = SessionManager.create(cwd, child.getSessionFile().replace(/\.jsonl$/, ''))
  managers.push(grandchild)
  grandchild.appendMessage({ role: 'user', content: 'grandchild research', timestamp: Date.now() })
  await grandchild.ensureOnDisk()
  await grandchild.flush()

  for (const target of [child, grandchild]) {
    const command = buildAiVaultResumeCommand({
      agent: 'omp',
      sessionId: target.getSessionId(),
      resumeFilePath: target.getSessionFile(),
      cwd: null,
      platform: process.platform,
      shell: 'posix'
    })

    const tokens = tokenizeStartupCommand(command, 'posix')
    assert.ok(tokens.ok)
    const args = parseArgs(tokens.tokens.slice(1))
    assert.equal(args.resume, target.getSessionFile())
    const settings = await Settings.init({ cwd })
    const resumed = await createSessionManager(args, cwd, settings)
    managers.push(resumed)
    assert.equal(resumed.getSessionId(), target.getSessionId())
    assert.notEqual(resumed.getSessionId(), parent.getSessionId())
  }

  console.log(
    JSON.stringify({
      childPathResumed: true,
      grandchildPathResumed: true,
      distinctFromParent: true,
      folderWorkspace: true,
      modelCalls: 0
    })
  )
} finally {
  for (const manager of managers) {
    await manager?.close()
  }

  await rm(scratch, { recursive: true, force: true })
}
