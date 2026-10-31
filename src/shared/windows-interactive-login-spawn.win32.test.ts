import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { buildWindowsHostInteractiveLoginSpawn } from './windows-interactive-login-spawn'

function runHiddenLogin(command: string, env: NodeJS.ProcessEnv): number | null {
  const login = buildWindowsHostInteractiveLoginSpawn(command, ['login'])
  // /b keeps the login in this hidden console instead of opening a window; exit codes are unchanged.
  const args = [...login.args]
  args.splice(args.indexOf('/wait') + 1, 0, '/b')
  try {
    return spawnSync(login.command, args, { env, stdio: 'ignore', windowsHide: true }).status
  } finally {
    login.cleanup()
  }
}

// Only a real cmd.exe start + PowerShell round trip shows which exit code reaches Orca.
describe.skipIf(process.platform !== 'win32')('Windows interactive login exit code', () => {
  let profile: string
  beforeEach(() => {
    profile = join(mkdtempSync(join(tmpdir(), 'orca-interactive-login-')), '홍길동')
    mkdirSync(profile)
  })
  afterEach(() => {
    rmSync(join(profile, '..'), { recursive: true, force: true })
  })

  it('returns a failed login exit code from a non-ASCII profile path', () => {
    const home = join(profile, 'codex-accounts', 'home')
    mkdirSync(home, { recursive: true })
    const launcher = join(profile, 'codex.cmd')
    writeFileSync(
      launcher,
      ['@echo off', 'echo %~1>"%CODEX_HOME%\\auth.json"', 'exit /b 3', ''].join('\r\n')
    )

    expect(runHiddenLogin(launcher, { ...process.env, CODEX_HOME: home })).toBe(3)
    expect(readFileSync(join(home, 'auth.json'), 'utf8').trim()).toBe('login')
  })

  it('fails when the login CLI never starts', () => {
    expect(runHiddenLogin(join(profile, 'missing.exe'), process.env)).toBe(1)
  })
})
