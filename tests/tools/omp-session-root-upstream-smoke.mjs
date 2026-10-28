// Bun; argv[2] is a read-only OMP checkout. Resolves paths without model requests.
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { resolveOmpSessionsDir } from '../../src/main/ai-vault/omp-session-root.ts'

assert.ok(process.argv[2], 'Pass a read-only OMP checkout path')
const root = await mkdtemp(join(tmpdir(), 'orca-omp-root-parity-'))
const home = join(root, 'home')
const xdg = join(root, 'data')
const keys = [
  'OMP_CODING_AGENT_DIR',
  'OMP_PROFILE',
  'PI_PROFILE',
  'PI_CONFIG_DIR',
  'PI_CODING_AGENT_DIR',
  'XDG_DATA_HOME',
  'XDG_STATE_HOME',
  'XDG_CACHE_HOME'
]
process.env.HOME = home
process.env.USERPROFILE = home
for (const key of keys) {
  delete process.env[key]
}
const passed = []
try {
  await mkdir(join(home, '.omp', 'agent', 'sessions'), { recursive: true })
  const upstream = await import(
    pathToFileURL(join(resolve(process.argv[2]), 'packages/utils/src/dirs.ts')).href
  )
  const check = (label, env) => {
    for (const key of keys) {
      delete process.env[key]
    }
    Object.assign(process.env, env)
    upstream.__resetDirsFromEnvForTests()
    assert.equal(resolveOmpSessionsDir(), upstream.getSessionsDir(), label)
    passed.push(label)
  }
  check('legacy without XDG', {})
  await mkdir(join(home, '.local', 'share', 'omp', 'sessions'), { recursive: true })
  check('no implicit XDG fallback', {})
  check('missing XDG app root', { XDG_DATA_HOME: xdg })
  await mkdir(join(xdg, 'omp'), { recursive: true })
  check('existing XDG app wins over legacy sessions', { XDG_DATA_HOME: xdg })
  check('named profile stays in config until its own XDG root exists', {
    XDG_DATA_HOME: xdg,
    OMP_PROFILE: 'work',
    PI_CONFIG_DIR: '.config/omp'
  })
  await mkdir(join(xdg, 'omp', 'profiles', 'work'), { recursive: true })
  check('named migrated profile', { XDG_DATA_HOME: xdg, OMP_PROFILE: 'work' })
  check('legacy profile fallback', { XDG_DATA_HOME: xdg, PI_PROFILE: 'work' })
  check('canonical empty profile ignores fallback', {
    XDG_DATA_HOME: xdg,
    OMP_PROFILE: '',
    PI_PROFILE: 'work'
  })
  check('relative agent override', { PI_CODING_AGENT_DIR: '.' })
  check('custom agent disables XDG', {
    XDG_DATA_HOME: xdg,
    PI_CODING_AGENT_DIR: join(root, 'custom')
  })
  check('named profile ignores custom agent', {
    XDG_DATA_HOME: xdg,
    OMP_PROFILE: 'work',
    PI_CODING_AGENT_DIR: join(root, 'custom')
  })
  check('default agent explicit override permits XDG', {
    XDG_DATA_HOME: xdg,
    PI_CODING_AGENT_DIR: join(home, '.omp', 'agent')
  })
  check('canonical default discards inherited profile agent', {
    OMP_PROFILE: '',
    PI_PROFILE: 'work',
    PI_CODING_AGENT_DIR: join(home, '.omp', 'profiles', 'work', 'agent')
  })
  console.log(
    JSON.stringify({ platform: process.platform, upstreamParityCases: passed, modelCalls: 0 })
  )
} finally {
  await rm(root, { recursive: true, force: true })
}
