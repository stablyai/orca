import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'

export type FakeProviderPickupMode =
  | { kind: 'success'; result: unknown }
  | { kind: 'diverge-until-choice'; details: unknown; result: unknown }
  | { kind: 'hang' }

export type FakeProviderFixture = {
  status: unknown
  list: unknown
  pickup: Record<string, FakeProviderPickupMode>
}

export type FakeProviderInvocation = {
  argv: string[]
  env: Record<string, string | null>
  pid: number
}

export type FakeProviderHang = { pid: number; grandchildPid: number }

export const RECORDED_PROVIDER_ENV_KEYS = [
  'ORCA_ENVIRONMENT',
  'ORCA_PAIRING_CODE',
  'ORCA_REMOTE_PAIRING',
  'CC_SYNC_ORCA_CLIENT_INSTANCE_ID'
] as const

// Why a real executable: the main bridge spawns the provider by path with argv arrays, so only a
// process on disk exercises spawn, env scrubbing, progress streaming and process-group cancel.
const PROVIDER_SOURCE = String.raw`
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const dir = path.dirname(fileURLToPath(import.meta.url))
const argv = process.argv.slice(2)
const env = Object.fromEntries(KEYS.map((key) => [key, process.env[key] ?? null]))
appendFileSync(path.join(dir, 'invocations.jsonl'), JSON.stringify({ argv, env, pid: process.pid }) + '\n')
const fixture = JSON.parse(readFileSync(path.join(dir, 'fixture.json'), 'utf8'))
const print = (value, code = 0) => {
  process.stdout.write(JSON.stringify(value))
  process.exit(code)
}
const progress = (phase, extra = {}) => process.stderr.write(JSON.stringify({ phase, ...extra }) + '\n')
switch (argv[0]) {
  case 'status':
    print(fixture.status)
    break
  case 'list':
    print(fixture.list)
    break
  case 'pickup': {
    const mode = fixture.pickup[argv[1]]
    if (!mode) {
      print({ version: 1, ok: false, error: { code: 'not-found', message: 'no such item ' + argv[1] } }, 3)
    }
    progress('select')
    if (mode.kind === 'hang') {
      progress('restore-code', { done: 1, total: 3 })
      const grandchild = spawn('sleep', ['600'], { stdio: 'ignore' })
      writeFileSync(path.join(dir, 'hang.json'), JSON.stringify({ pid: process.pid, grandchildPid: grandchild.pid }))
      setInterval(() => {}, 1000)
      break
    }
    if (mode.kind === 'diverge-until-choice' && !argv.includes('--on-divergence')) {
      print({ version: 1, ok: false, error: { code: 'divergent-local-copy', message: 'This computer has a newer local copy.', details: mode.details } }, 4)
    }
    progress('orca-import')
    print(mode.result)
    break
  }
  default:
    print({ version: 1, ok: false, error: { code: 'unsupported', message: 'unsupported ' + argv[0] } }, 2)
}
`

export type FakeRecoveryProvider = {
  dir: string
  programPath: string
  invocations: () => FakeProviderInvocation[]
  readHang: () => FakeProviderHang | null
}

export function createFakeRecoveryProvider(
  dir: string,
  fixture: FakeProviderFixture,
  programName = 'cc-sync'
): FakeRecoveryProvider {
  mkdirSync(dir, { recursive: true })
  const programPath = path.join(dir, programName)
  writeFileSync(path.join(dir, 'fixture.json'), JSON.stringify(fixture))
  writeFileSync(path.join(dir, 'invocations.jsonl'), '')
  // Why a sibling .mjs: the shebang file has no extension, so Node would load it as CommonJS.
  writeFileSync(
    programPath,
    `#!${process.execPath}\nimport(${JSON.stringify(path.join(dir, 'provider.mjs'))})\n`
  )
  writeFileSync(
    path.join(dir, 'provider.mjs'),
    `const KEYS = ${JSON.stringify(RECORDED_PROVIDER_ENV_KEYS)}\n${PROVIDER_SOURCE}`
  )
  chmodSync(programPath, 0o755)
  return {
    dir,
    programPath,
    invocations: () =>
      readFileSync(path.join(dir, 'invocations.jsonl'), 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as FakeProviderInvocation),
    readHang: () => {
      const file = path.join(dir, 'hang.json')
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as FakeProviderHang) : null
    }
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
