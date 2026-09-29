import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const fixture = vi.hoisted(() => ({
  exec: vi.fn(),
  exists: vi.fn(),
  write: vi.fn()
}))

vi.mock('node:child_process', () => ({ execSync: fixture.exec }))
vi.mock('node:fs', () => ({
  existsSync: fixture.exists,
  mkdirSync: vi.fn(),
  mkdtempSync: (prefix: string) => `${prefix}fixture`,
  realpathSync: (value: string) => value,
  writeFileSync: fixture.write
}))
vi.mock('./helpers/docker-ssh-relay-image', () => ({ prepareDockerSshRelayImage: vi.fn() }))

import globalSetup from './global-setup'

beforeEach(() => {
  vi.resetAllMocks()
  fixture.exists.mockReturnValue(true)
  for (const name of [
    'SKIP_BUILD',
    'ORCA_E2E_WEB_CLIENT',
    'ORCA_E2E_SSH_LOCALHOST',
    'ORCA_E2E_SSH_DOCKER',
    'ORCA_E2E_NESTED_RUNTIME_SSH',
    'ORCA_E2E_SKILL_STAGING',
    'ORCA_E2E_TEST_REPO_PATH_FILE'
  ]) {
    vi.stubEnv(name, '')
  }
})

afterEach(() => vi.unstubAllEnvs())

function commands(): string[] {
  return fixture.exec.mock.calls.map(([command]) => command)
}

describe('E2E shared CLI artifact', () => {
  it('repairs downloaded permissions and installs the local launcher without recompiling', () => {
    vi.stubEnv('SKIP_BUILD', '1')
    globalSetup()
    const prepare = commands().find((command) => command.includes('prepare:cli-output'))
    expect(prepare).toBe('pnpm run prepare:cli-output')
    expect(commands()).not.toContain('pnpm run build:cli')
    expect(commands()).toContain('git init')
    expect(fixture.exec.mock.calls.find(([command]) => command === prepare)?.[1]).toEqual({
      cwd: process.cwd(),
      stdio: 'inherit',
      timeout: 120_000
    })
  })

  it('builds a missing CLI even when the other artifacts exist', () => {
    vi.stubEnv('SKIP_BUILD', '1')
    fixture.exists.mockImplementation(
      (file) => file !== path.join(process.cwd(), 'out', 'cli', 'index.js')
    )
    globalSetup()
    expect(commands()).toContain('pnpm run build:cli')
    expect(commands().some((command) => command.includes('prepare:cli-output'))).toBe(false)
  })

  it('rebuilds existing artifacts when reuse is not requested', () => {
    globalSetup()
    expect(commands()).toContain('npx electron-vite build --mode e2e')
    expect(commands()).toContain('pnpm run build:cli')
  })

  it('fails setup if the downloaded CLI cannot be verified', () => {
    vi.stubEnv('SKIP_BUILD', '1')
    fixture.exec.mockImplementation((command) => {
      if (command.includes('prepare:cli-output')) {
        throw new Error('Invalid CLI artifact')
      }
    })
    expect(() => globalSetup()).toThrow('Invalid CLI artifact')
    expect(commands()).not.toContain('git init')
  })
})
