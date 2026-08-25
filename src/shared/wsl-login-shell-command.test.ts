import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildWslExecArgs,
  buildWslInteractiveLoginShellCommand,
  buildWslLoginShellCommand,
  quotePosixShell
} from './wsl-login-shell-command'

const WSL_TEST_COMMAND_TIMEOUT_MS = 10_000
let wslShAvailable: boolean | null = null

function canRunWslSh(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  if (wslShAvailable !== null) {
    return wslShAvailable
  }
  try {
    execFileSync('wsl.exe', ['--exec', 'sh', '-lc', 'true'], {
      timeout: WSL_TEST_COMMAND_TIMEOUT_MS
    })
    wslShAvailable = true
  } catch {
    wslShAvailable = false
  }
  return wslShAvailable
}

function expectValidShSyntax(command: string): void {
  try {
    execFileSync('sh', ['-n'], { input: command, timeout: WSL_TEST_COMMAND_TIMEOUT_MS })
    return
  } catch (error) {
    if (
      process.platform !== 'win32' ||
      !(error instanceof Error && 'code' in error && error.code === 'ENOENT')
    ) {
      throw error
    }
  }
  if (!canRunWslSh()) {
    return
  }
  execFileSync('wsl.exe', ['--exec', 'sh', '-n'], {
    input: command,
    timeout: WSL_TEST_COMMAND_TIMEOUT_MS
  })
}

describe('wsl login shell command helpers', () => {
  it('quotes single quotes for POSIX shell arguments', () => {
    expect(quotePosixShell("a'b")).toBe("'a'\\''b'")
  })

  it('runs commands through the distro user login shell', () => {
    const command = buildWslLoginShellCommand("printf 'hello'")

    expect(command).toContain('getent passwd')
    expect(command).toContain('bash|zsh|ksh|mksh|ash)')
    expect(command).toContain('exec "$_orca_wsl_shell" -ilc')
    expect(command).toContain('exec /bin/sh -lc')
    expect(command).toContain("printf '\\''hello'\\''")
  })

  it.skipIf(process.platform === 'win32')(
    'resolves env-node launchers from the current login-shell PATH on every run',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-login-codex-'))
      const tools = join(root, 'tools')
      const loginBin = join(root, 'login')
      const v1Bin = join(root, 'nvm-v1')
      const v2Bin = join(root, 'nvm-v2')
      mkdirSync(tools)
      mkdirSync(loginBin)
      mkdirSync(v1Bin)
      mkdirSync(v2Bin)
      const loginShell = join(loginBin, 'bash')
      writeFileSync(
        join(tools, 'getent'),
        `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::/home/user:$ORCA_TEST_LOGIN_SHELL"\n`
      )
      writeFileSync(
        loginShell,
        '#!/bin/sh\nexport PATH="$ORCA_TEST_CODEX_BIN:/usr/bin:/bin"\nexec /bin/sh -c "$2"\n'
      )
      for (const [bin, label] of [
        [v1Bin, 'v1'],
        [v2Bin, 'v2']
      ] as const) {
        writeFileSync(join(bin, 'codex'), '#!/usr/bin/env node\n')
        writeFileSync(join(bin, 'node'), `#!/bin/sh\nprintf '%s' '${label}'\n`)
        chmodSync(join(bin, 'codex'), 0o755)
        chmodSync(join(bin, 'node'), 0o755)
      }
      chmodSync(join(tools, 'getent'), 0o755)
      chmodSync(loginShell, 0o755)

      const command = buildWslLoginShellCommand('exec codex')
      const run = (codexBin: string): string =>
        execFileSync('/bin/sh', ['-c', command], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tools}:/usr/bin:/bin`,
            ORCA_TEST_LOGIN_SHELL: loginShell,
            ORCA_TEST_CODEX_BIN: codexBin
          }
        })

      try {
        expect(run(v1Bin)).toBe('v1')
        // The old launcher remains executable; current PATH precedence wins.
        expect(run(v2Bin)).toBe('v2')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('keeps command-scoped environment variables in the quoted payload', () => {
    const command = buildWslLoginShellCommand('HISTFILE=/tmp/orca-history printf "$HISTFILE"')

    expect(command).toContain('\'HISTFILE=/tmp/orca-history printf "$HISTFILE"\'')
    expectValidShSyntax(command)
  }, 30_000)

  it('routes through --exec so wsl.exe cannot preprocess argv', () => {
    expect(buildWslExecArgs('Ubuntu', ['sh', '-lc', 'printf "$HOME"'])).toEqual([
      '-d',
      'Ubuntu',
      '--exec',
      'sh',
      '-lc',
      'printf "$HOME"'
    ])
    // A distro-less target still has to bypass the `--` preprocessor.
    expect(buildWslExecArgs(undefined, ['sh', '-c', 'true'])).toEqual([
      '--exec',
      'sh',
      '-c',
      'true'
    ])
  })

  it('preserves user command variables across the Windows-to-WSL argv boundary', () => {
    if (!canRunWslSh()) {
      return
    }

    const command = buildWslLoginShellCommand('orca_value=ok; printf "<%s>" "$orca_value"')

    expect(
      execFileSync('wsl.exe', buildWslExecArgs(undefined, ['sh', '-lc', command]), {
        encoding: 'utf8',
        timeout: WSL_TEST_COMMAND_TIMEOUT_MS
      })
    ).toBe('<ok>')
  }, 30_000)

  // Why: `--` expands $name in argv against the guest env before the guest runs,
  // so these scripts reached the shell already rewritten. Each case below was
  // measured to return DIFFERENT bytes under `--` than under `--exec`; cases
  // that merely look risky but are unaffected (a sed backreference has no `$`)
  // are deliberately not here, because they would pass either way.
  it.each([
    ['awk field reference', ['sh', '-c', `echo 'a b' | awk '{print $2}'`], 'b\n'],
    ['literal escaped dollar', ['sh', '-c', `printf '[%s]' "\\$HOME"`], '[$HOME]'],
    ['single-quoted dollar', ['sh', '-c', `printf '[%s]' '$PATH'`], '[$PATH]'],
    // The shape wslUncDirectoryExists uses: `--` blanked $1, so every existing
    // directory probed as missing.
    ['positional argument', ['sh', '-c', 'printf "[%s]" "$1"', 'sh', 'ARG'], '[ARG]'],
    ['shell local', ['sh', '-c', 'x=hi; printf "[%s]" "$x"'], '[hi]']
  ])(
    'passes %s to the guest byte-for-byte',
    (_name, shellArgs, expected) => {
      if (!canRunWslSh()) {
        return
      }

      expect(
        execFileSync('wsl.exe', buildWslExecArgs(undefined, shellArgs), {
          encoding: 'utf8',
          timeout: WSL_TEST_COMMAND_TIMEOUT_MS
        })
      ).toBe(expected)
    },
    30_000
  )

  it('starts an interactive login shell without assuming bash', () => {
    const command = buildWslInteractiveLoginShellCommand()

    expect(command).toContain('getent passwd')
    expect(command).toContain('if [ -z "$_orca_wsl_shell" ] || [ ! -x "$_orca_wsl_shell" ]; then')
    expect(command).toContain('_orca_shell_ready_root=""')
    expect(command).toContain('if [ -n "${ORCA_USER_DATA_PATH:-}" ]; then')
    expect(command).toContain('_orca_wsl_shell_name=$(basename "$_orca_wsl_shell"')
    expect(command).toContain('bash)')
    expect(command).toContain('--rcfile "${_orca_shell_ready_root}/bash/rcfile"')
    expect(command).toContain('zsh)')
    expect(command).toContain('export ZDOTDIR="${_orca_shell_ready_root}/zsh"')
    expect(command).toContain('exec "$_orca_wsl_shell" -l')
    expectValidShSyntax(command)
  })
})
