import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { build } from 'esbuild'
import { spawnProcess } from '../../src/shared/child-process/run-process.ts'
import { buildRelayAiVaultServiceEnv } from '../../src/main/ai-vault/session-scanner-service-env.ts'
import { getRemoteHostPlatform } from '../../src/main/ssh/ssh-remote-platform.ts'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout')
const node = Bun.which('node')
assert.ok(node, 'A native Node executable is required')
const root = fileURLToPath(new URL('../../', import.meta.url))
const scratch = await mkdtemp(join(tmpdir(), 'orca-omp-relay-root-'))
const home = join(scratch, 'home')
const xdg = join(scratch, 'data')
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  XDG_CONFIG_HOME: join(scratch, 'config'),
  XDG_DATA_HOME: xdg,
  XDG_STATE_HOME: join(scratch, 'state'),
  XDG_CACHE_HOME: join(scratch, 'cache')
})
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
const source = (path) => pathToFileURL(join(resolve(process.argv[2]), path)).href
const managers = []
const entry = join(scratch, 'relay-ai-vault-service.cjs')

async function scan(profile, env = process.env) {
  const child = spawnProcess({
    program: node,
    args: [entry],
    cwd: scratch,
    env: { ...buildRelayAiVaultServiceEnv(env), ORCA_BACKGROUND_LAUNCH: '1' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  })
  let stderr = ''
  child.stderr.on('data', (data) => {
    stderr = (stderr + data).slice(-16000)
  })
  const exited = new Promise((resolveExit) => child.once('exit', resolveExit))
  let timer
  try {
    const result = new Promise((resolveResult, reject) => {
      timer = setTimeout(() => reject(new Error(`Relay scan timed out: ${stderr}`)), 15000)
      child.once('error', reject)
      child.once('exit', (code) => reject(new Error(`Relay exited ${code}: ${stderr}`)))
      child.on('message', (message) => {
        if (message.type === 'ready') {
          child.send({ type: 'request', id: 1, operation: 'list', params: { limit: 20 } })
        } else if (message.type === 'error') {
          reject(new Error(message.message))
        } else if (message.type === 'result') {
          resolveResult(message.value)
        }
      })
    })
    child.send({
      type: 'init',
      protocol: 1,
      remoteHome: home,
      hostPlatform: getRemoteHostPlatform(`${process.platform}-${process.arch}`)
    })
    const value = await result
    assert.equal(value.issues.length, 0, JSON.stringify(value.issues))
    const sessions = value.sessions.filter((session) => session.agent === 'omp')
    if (profile === 'invalid') {
      assert.deepEqual(sessions, [])
    } else {
      const manager = managers.at(-1)
      assert.equal(sessions.length, 1)
      assert.equal(sessions[0].sessionId, manager.getSessionId())
      assert.equal(sessions[0].filePath, manager.getSessionFile())
      assert.equal(sessions[0].cwd, join(scratch, 'folder workspace'))
    }
    return { profile: profile || 'default', sessions: sessions.length, actualNodeSidecar: true }
  } finally {
    clearTimeout(timer)
    child.kill()
    await exited
  }
}

try {
  await mkdir(join(home, '.omp', 'agent', 'sessions'), { recursive: true })
  await mkdir(join(xdg, 'omp', 'profiles', 'work'), { recursive: true })
  await build({
    entryPoints: [join(root, 'src/relay/ai-vault-service-entry.ts')],
    bundle: true,
    platform: 'node',
    target: 'node18',
    format: 'cjs',
    outfile: entry,
    external: ['electron'],
    define: { 'process.env.NODE_ENV': '"production"' }
  })
  const upstream = await import(source('packages/utils/src/dirs.ts'))
  const { SessionManager } = await import(
    source('packages/coding-agent/src/session/session-manager.ts')
  )
  const results = []
  for (const profile of ['', 'work']) {
    process.env.OMP_PROFILE = profile
    upstream.__resetDirsFromEnvForTests()
    const cwd = join(scratch, 'folder workspace')
    await mkdir(cwd, { recursive: true })
    const manager = SessionManager.create(cwd)
    managers.push(manager)
    manager.appendMessage({
      role: 'user',
      content: 'OMP relay history proof',
      timestamp: Date.now()
    })
    await manager.ensureOnDisk()
    await manager.flush()
    const expected = join(xdg, 'omp', ...(profile ? ['profiles', profile] : []), 'sessions')
    assert.ok(manager.getSessionFile().startsWith(expected))
    results.push(await scan(profile))
  }
  results.push(await scan('invalid', { ...process.env, OMP_PROFILE: '../invalid' }))
  console.log(
    JSON.stringify({
      results,
      actualOmpPersistence: true,
      legacyDirectoryCoexists: true,
      modelCalls: 0
    })
  )
} finally {
  for (const manager of managers) {
    await manager.close()
  }
  await rm(scratch, { recursive: true, force: true })
}
