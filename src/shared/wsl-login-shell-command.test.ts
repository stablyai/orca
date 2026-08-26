import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildWslCapturedLoginShellCommand,
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

    // Why the captured form: an interactive login shell also prints the distro's
    // rc/motd to stdout (stock Ubuntu ships a sudo hint), so a raw login-shell
    // read cannot be compared byte-for-byte on a real distro.
    const captured = buildWslCapturedLoginShellCommand('orca_value=ok; printf "<%s>" "$orca_value"')

    expect(
      captured.readStdout(
        execFileSync('wsl.exe', buildWslExecArgs(undefined, ['sh', '-lc', captured.command]), {
          encoding: 'utf8',
          timeout: WSL_TEST_COMMAND_TIMEOUT_MS
        })
      )
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

  describe('captured login shell', () => {
    it('returns only the fenced payload, dropping rc banner noise', () => {
      const captured = buildWslCapturedLoginShellCommand('printf directory', 'nonce1')

      expect(
        captured.readStdout(
          'To run a command as administrator (user "root"), use "sudo <command>".\n\n' +
            '__ORCA_WSL_CAPTURE_BEGIN_nonce1__directory__ORCA_WSL_CAPTURE_END_nonce1__'
        )
      ).toBe('directory')
    })

    it.skipIf(!canRunWslSh())(
      'propagates the payload exit status to the caller',
      () => {
        // Why a real shell: asserting the script merely *contains* `exit $?` passes
        // for any input. statPath maps this exit 2 to ENOENT, so it has to survive
        // the fence for real.
        const captured = buildWslCapturedLoginShellCommand('printf partial; exit 2')

        let status: number | undefined
        try {
          execFileSync('wsl.exe', buildWslExecArgs(undefined, ['sh', '-lc', captured.command]), {
            encoding: 'utf8',
            timeout: WSL_TEST_COMMAND_TIMEOUT_MS,
            stdio: ['pipe', 'pipe', 'pipe']
          })
        } catch (error) {
          status = (error as { status?: number }).status
        }

        expect(status).toBe(2)
      },
      30_000
    )

    it('emits the status plumbing the payload needs', () => {
      const captured = buildWslCapturedLoginShellCommand('exit 2', 'nonce1')

      expect(captured.command).toContain('_orca_capture_status=$?')
      expect(captured.command).toContain('exit $_orca_capture_status')
    })

    it('keeps payload bytes that themselves contain a fence', () => {
      // Why a per-call nonce: `cat` of a file quoting a fixed marker would
      // otherwise be truncated at the quote.
      const captured = buildWslCapturedLoginShellCommand('cat -- /f', 'nonce2')
      const payload = 'see __ORCA_WSL_CAPTURE_BEGIN_nonce1__ and __ORCA_WSL_CAPTURE_END_nonce1__\n'

      expect(
        captured.readStdout(
          `banner\n__ORCA_WSL_CAPTURE_BEGIN_nonce2__${payload}__ORCA_WSL_CAPTURE_END_nonce2__`
        )
      ).toBe(payload)
    })

    it('returns null when the fence never appeared', () => {
      const captured = buildWslCapturedLoginShellCommand('printf hi', 'nonce1')

      expect(captured.readStdout('bash: line 1: command not found\n')).toBeNull()
    })

    it('returns the tail when a payload exits before the closing fence', () => {
      const captured = buildWslCapturedLoginShellCommand('printf partial; exit 2', 'nonce1')

      expect(captured.readStdout('banner\n__ORCA_WSL_CAPTURE_BEGIN_nonce1__partial')).toBe(
        'partial'
      )
    })

    it('gives each invocation a distinct fence', () => {
      const first = buildWslCapturedLoginShellCommand('printf hi')
      const second = buildWslCapturedLoginShellCommand('printf hi')

      expect(first.command).not.toBe(second.command)
    })

    it.skipIf(!canRunWslSh())(
      'reads a clean payload back from a real distro login shell',
      () => {
        const captured = buildWslCapturedLoginShellCommand('printf directory')
        const stdout = execFileSync(
          'wsl.exe',
          buildWslExecArgs(undefined, ['sh', '-lc', captured.command]),
          { encoding: 'utf8', timeout: WSL_TEST_COMMAND_TIMEOUT_MS }
        )

        expect(captured.readStdout(stdout)).toBe('directory')
      },
      30_000
    )
  })

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

describe('in-guest wrapper root resolution', () => {
  // Why this test exists: the wrapper tree is content-addressed, so its path
  // carries a hash the guest cannot derive. A previous revision of this script
  // rebuilt the root as `${ORCA_USER_DATA_PATH}/shell-ready`, which stopped
  // matching -- every WSL pane then fell through to an unwrapped `exec $shell -l`
  // and silently lost the ready marker, OSC 133, and the launch preflight.
  it('prefers the host-published root over the legacy user-data guess', () => {
    const script = buildWslInteractiveLoginShellCommand()
    expect(script).toContain('if [ -n "${ORCA_SHELL_READY_ROOT:-}" ]; then')
    expect(script).toContain('_orca_shell_ready_root="${ORCA_SHELL_READY_ROOT%/}"')
    // The legacy branch must remain reachable only as a fallback, so an older
    // host that exports just ORCA_USER_DATA_PATH still wraps its shells.
    expect(script).toContain('elif [ -n "${ORCA_USER_DATA_PATH:-}" ]; then')
  })

  it('resolves the published root ahead of the legacy path under a real shell', () => {
    const script = buildWslInteractiveLoginShellCommand()
    // Run only the root-resolution prologue, then report what it picked.
    const prologue = script.split('_orca_wsl_shell_name=')[0] as string
    const probe = [
      'ORCA_SHELL_READY_ROOT=/mnt/c/ud/shell-wrappers/deadbeefdeadbeef/shell-ready',
      'ORCA_USER_DATA_PATH=/mnt/c/ud',
      'export ORCA_SHELL_READY_ROOT ORCA_USER_DATA_PATH',
      prologue,
      'printf "%s" "$_orca_shell_ready_root"'
    ].join('\n')
    const result = spawnSync('sh', ['-c', probe], { encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('/mnt/c/ud/shell-wrappers/deadbeefdeadbeef/shell-ready')
  })
})
