import { execFileSync } from 'node:child_process'
import {
  accessSync,
  chmodSync,
  constants,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildWslInteractiveLoginShellCommand,
  buildWslLoginShellCommand,
  escapeWslShCommandForWindows,
  quotePosixShell
} from './wsl-login-shell-command'

const WSL_TEST_COMMAND_TIMEOUT_MS = 10_000
let wslShAvailable: boolean | null = null

function findFishExecutable(): string | null {
  if (process.platform === 'win32') {
    return null
  }
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) {
      continue
    }
    const candidate = join(directory, 'fish')
    try {
      accessSync(candidate, constants.X_OK)
      return candidate
    } catch {
      // Keep checking PATH so the test works with distro and Homebrew fish installs.
    }
  }
  return null
}

const fishExecutable = findFishExecutable()

function findSystemShellExecutable(name: string): string | null {
  if (process.platform === 'win32') {
    return null
  }
  const candidate = join('/', 'bin', name)
  try {
    accessSync(candidate, constants.X_OK)
    return candidate
  } catch {
    return null
  }
}

const kshExecutable = findSystemShellExecutable('ksh')
const dashExecutable = findSystemShellExecutable('dash')

function canRunWslSh(): boolean {
  if (process.platform !== 'win32') {
    return false
  }
  if (wslShAvailable !== null) {
    return wslShAvailable
  }
  try {
    execFileSync('wsl.exe', ['--', 'sh', '-lc', 'true'], {
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
  execFileSync('wsl.exe', ['--', 'sh', '-n'], {
    input: command,
    timeout: WSL_TEST_COMMAND_TIMEOUT_MS
  })
}

function expectSafePosixShellMaterializerFallback(
  shellName: 'dash' | 'ksh',
  shellExecutable: string
): void {
  const root = mkdtempSync(join(tmpdir(), `orca-wsl-${shellName}-materializer-`))
  const tools = join(root, 'tools')
  const loginShell = join(tools, shellName)
  const startupCalls = join(root, 'startup-calls')
  const interactiveRc = join(root, '.interactive-rc')
  const materializer = join(root, 'materialize.sh')
  mkdirSync(tools)
  writeFileSync(
    join(tools, 'getent'),
    `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::/home/user:$ORCA_TEST_LOGIN_SHELL"\n`
  )
  // Why: stdin is a pipe in Vitest; -i exercises the real shell's ENV startup
  // path while the generated WSL command still supplies its production -l.
  writeFileSync(loginShell, '#!/bin/sh\nexec "$ORCA_TEST_REAL_LOGIN_SHELL" -i "$@"\n')
  writeFileSync(
    join(root, '.profile'),
    [
      'printf p >> "$ORCA_TEST_STARTUP_CALLS"',
      'export OPENCODE_CONFIG_DIR="/guest/from-profile"',
      'ENV="$ORCA_TEST_INTERACTIVE_RC"',
      'export ENV',
      ''
    ].join('\n')
  )
  writeFileSync(
    interactiveRc,
    [
      'printf r >> "$ORCA_TEST_STARTUP_CALLS"',
      'export OPENCODE_CONFIG_DIR="/guest/from-interactive-rc"',
      ''
    ].join('\n')
  )
  writeFileSync(
    materializer,
    [
      'printf m >> "$ORCA_TEST_STARTUP_CALLS"',
      'export OPENCODE_CONFIG_DIR="/guest/orca-overlay"',
      'export ORCA_OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_DIR"',
      ''
    ].join('\n')
  )
  chmodSync(join(tools, 'getent'), 0o755)
  chmodSync(loginShell, 0o755)

  try {
    const output = execFileSync('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
      encoding: 'utf8',
      input: 'printf "%s\\n" "$OPENCODE_CONFIG_DIR"\nexit\n',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: root,
        PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
        ORCA_TEST_INTERACTIVE_RC: interactiveRc,
        ORCA_TEST_LOGIN_SHELL: loginShell,
        ORCA_TEST_REAL_LOGIN_SHELL: shellExecutable,
        ORCA_TEST_STARTUP_CALLS: startupCalls,
        ORCA_WSL_OPENCODE_MATERIALIZER: materializer
      }
    })

    expect(output).toBe('/guest/from-interactive-rc\n')
    // Why: shells without a forced post-login hook must keep user startup
    // semantics even though that means their later config value wins.
    expect(readFileSync(startupCalls, 'utf8')).toBe('mpr')
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
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

  it('preserves command-scoped environment variables through the outer WSL shell', () => {
    const command = buildWslLoginShellCommand('HISTFILE=/tmp/orca-history printf "$HISTFILE"')
    const escaped = escapeWslShCommandForWindows(command)

    expect(command).toContain('\'HISTFILE=/tmp/orca-history printf "$HISTFILE"\'')
    expect(escaped).toContain('\\$_orca_wsl_shell')
    expect(escaped).toContain('\\${SHELL:-/bin/bash}')
    expect(escaped).toContain('\\$(getent passwd "\\$(id -un)"')
    expect(escaped).toContain('\\$HISTFILE')
    expectValidShSyntax(command)
  }, 30_000)

  it('does not double-escape wrapper shell variables', () => {
    const command = 'echo \\$_orca_wsl_shell "$_orca_wsl_shell"'

    expect(escapeWslShCommandForWindows(command)).toBe(
      'echo \\$_orca_wsl_shell "\\$_orca_wsl_shell"'
    )
  })

  it('escapes user command dollars inside POSIX-quoted payloads for WSL argv', () => {
    const command = buildWslLoginShellCommand(
      'HISTFILE=/tmp/orca-history printf "$HISTFILE"; printf \'%s\' "$SHELL"'
    )
    const escaped = escapeWslShCommandForWindows(command)

    expect(escaped).toContain(
      "'HISTFILE=/tmp/orca-history printf \"\\$HISTFILE\"; printf '\\''%s'\\'' \"\\$SHELL\"'"
    )
    expectValidShSyntax(command)
  }, 30_000)

  it('preserves user command variables across the Windows-to-WSL argv boundary', () => {
    if (!canRunWslSh()) {
      return
    }

    const command = buildWslLoginShellCommand('orca_value=ok; printf "<%s>" "$orca_value"')
    const escaped = escapeWslShCommandForWindows(command)

    expect(
      execFileSync('wsl.exe', ['--', 'sh', '-lc', escaped], {
        encoding: 'utf8',
        timeout: WSL_TEST_COMMAND_TIMEOUT_MS
      })
    ).toBe('<ok>')
  }, 30_000)

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
    expect(command).toContain('fish)')
    expect(command).toContain('--init-command')
    expect(command).toContain('ORCA_WSL_OPENCODE_MATERIALIZER')
    expect(command).toContain('. "$ORCA_WSL_OPENCODE_MATERIALIZER"')
    expect(command.indexOf('ORCA_WSL_OPENCODE_MATERIALIZER')).toBeLessThan(
      command.indexOf('exec "$_orca_wsl_shell" -l')
    )
    expect(command).toContain('exec "$_orca_wsl_shell" -l')
    expectValidShSyntax(command)
  })

  it.skipIf(process.platform === 'win32')(
    'sources the OpenCode materializer when a shell-ready wrapper is unavailable',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-materializer-launch-'))
      const tools = join(root, 'tools')
      const materializer = join(root, 'materialize.sh')
      mkdirSync(tools)
      writeFileSync(
        join(tools, 'getent'),
        `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::/home/user:$ORCA_TEST_LOGIN_SHELL"\n`
      )
      writeFileSync(join(tools, 'fish'), '#!/bin/sh\nprintf "%s" "$OPENCODE_CONFIG_DIR"\n')
      writeFileSync(materializer, 'export OPENCODE_CONFIG_DIR=/guest/overlay\n')
      chmodSync(join(tools, 'getent'), 0o755)
      chmodSync(join(tools, 'fish'), 0o755)

      try {
        const output = execFileSync('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
          encoding: 'utf8',
          env: {
            ...process.env,
            PATH: `${tools}:/usr/bin:/bin`,
            ORCA_TEST_LOGIN_SHELL: join(tools, 'fish'),
            ORCA_WSL_OPENCODE_MATERIALIZER: materializer
          }
        })
        expect(output).toBe('/guest/overlay')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(fishExecutable === null)(
    'materializes OpenCode after real fish login config overrides its config dir',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-fish-materializer-'))
      const tools = join(root, 'tools')
      const fishConfigDir = join(root, 'xdg', 'fish')
      const materializer = join(root, 'materialize.sh')
      const materializerCalls = join(root, 'materializer-calls')
      mkdirSync(tools)
      mkdirSync(fishConfigDir, { recursive: true })
      writeFileSync(
        join(tools, 'getent'),
        `#!/bin/sh\nprintf '%s\\n' "user:x:1000:1000::/home/user:$ORCA_TEST_LOGIN_SHELL"\n`
      )
      writeFileSync(
        join(fishConfigDir, 'config.fish'),
        'set -gx OPENCODE_CONFIG_DIR "/guest/from-fish-config"\n'
      )
      writeFileSync(
        materializer,
        [
          'printf x >> "$ORCA_TEST_MATERIALIZER_CALLS"',
          'if [ -n "${ORCA_OPENCODE_CONFIG_DIR:-}" ] && [ "$OPENCODE_CONFIG_DIR" = "$ORCA_OPENCODE_CONFIG_DIR" ]; then',
          '  return 1',
          'fi',
          'export ORCA_OPENCODE_SOURCE_CONFIG_DIR="$OPENCODE_CONFIG_DIR"',
          'export OPENCODE_CONFIG_DIR="/guest/orca-overlay"',
          'export ORCA_OPENCODE_CONFIG_DIR="$OPENCODE_CONFIG_DIR"',
          'export ORCA_AGENT_HOOK_ENDPOINT="/guest/endpoint.env"',
          ''
        ].join('\n')
      )
      chmodSync(join(tools, 'getent'), 0o755)

      try {
        const output = execFileSync('/bin/sh', ['-c', buildWslInteractiveLoginShellCommand()], {
          encoding: 'utf8',
          input:
            'printf "%s\\n%s\\n%s\\n" "$OPENCODE_CONFIG_DIR" "$ORCA_OPENCODE_SOURCE_CONFIG_DIR" "$ORCA_AGENT_HOOK_ENDPOINT"\n',
          env: {
            ...process.env,
            HOME: root,
            XDG_CONFIG_HOME: join(root, 'xdg'),
            PATH: `${tools}${delimiter}${process.env.PATH ?? ''}`,
            ORCA_TEST_LOGIN_SHELL: fishExecutable!,
            ORCA_TEST_MATERIALIZER_CALLS: materializerCalls,
            ORCA_WSL_OPENCODE_MATERIALIZER: materializer
          }
        })

        expect(output).toBe(
          ['/guest/orca-overlay', '/guest/from-fish-config', '/guest/endpoint.env', ''].join('\n')
        )
        // Why: pre-sourcing and then re-running after fish config would mirror
        // Orca's first overlay as if it were the user's source.
        expect(readFileSync(materializerCalls, 'utf8')).toBe('x')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.skipIf(kshExecutable === null)(
    'preserves real ksh profile and ENV startup when only the safe fallback is available',
    () => {
      expectSafePosixShellMaterializerFallback('ksh', kshExecutable!)
    }
  )

  it.skipIf(dashExecutable === null)(
    'preserves real dash profile and ENV startup when only the safe fallback is available',
    () => {
      expectSafePosixShellMaterializerFallback('dash', dashExecutable!)
    }
  )
})
