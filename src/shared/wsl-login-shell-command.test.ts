import { execFileSync, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildWslCapturedLoginShellCommand,
  buildWslExecArgs,
  buildWslInteractiveLoginShellCommand,
  buildWslLoginShellCommand
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

describe('wsl login shell command helpers', () => {
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

  it('preserves user command variables across the Windows-to-WSL argv boundary', () => {
    if (!canRunWslSh()) {
      return
    }

    // Fence interactive rc/motd stdout before comparing command output byte-for-byte.
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

  // These measured cases distinguish --exec from --, which expands guest $name references before execution.
  it.each([
    ['awk field reference', ['sh', '-c', `echo 'a b' | awk '{print $2}'`], 'b\n'],
    ['literal escaped dollar', ['sh', '-c', `printf '[%s]' "\\$HOME"`], '[$HOME]'],
    ['single-quoted dollar', ['sh', '-c', `printf '[%s]' '$PATH'`], '[$PATH]'],
    // The old preprocessor erased $1 in wslUncDirectoryExistsAsync and made existing directories appear missing.
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
    it.skipIf(!canRunWslSh())(
      'propagates the payload exit status to the caller',
      () => {
        // Run the shell to prove exit 2 survives the fence; statPath maps it to ENOENT.
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

    it('keeps payload bytes that themselves contain a fence', () => {
      // A per-call nonce prevents payloads quoting an older marker from truncating capture.
      const captured = buildWslCapturedLoginShellCommand('cat -- /f', 'nonce2')
      const payload = 'see __ORCA_WSL_CAPTURE_BEGIN_nonce1__ and __ORCA_WSL_CAPTURE_END_nonce1__\n'

      expect(
        captured.readStdout(
          `banner\n__ORCA_WSL_CAPTURE_BEGIN_nonce2__${payload}__ORCA_WSL_CAPTURE_END_nonce2__`
        )
      ).toBe(payload)
    })

    it('returns the tail when a payload exits before the closing fence', () => {
      const captured = buildWslCapturedLoginShellCommand('printf partial; exit 2', 'nonce1')

      expect(captured.readStdout('banner\n__ORCA_WSL_CAPTURE_BEGIN_nonce1__partial')).toBe(
        'partial'
      )
    })
  })
})

describe('in-guest wrapper root resolution', () => {
  it('resolves the published root ahead of the legacy path under a real shell', () => {
    const script = buildWslInteractiveLoginShellCommand()
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
