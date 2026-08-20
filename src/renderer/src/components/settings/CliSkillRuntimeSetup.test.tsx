import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildAgentFeatureSkillInstallCommand } from '../../../../shared/agent-feature-install-commands'
import { buildWslLoginShellCommand } from '../../../../shared/wsl-login-shell-command'
import { useAppStore } from '@/store'
import {
  buildSkillCommandForRuntime,
  buildSkillInstallCommandForRuntime,
  buildSkillSetupTerminalCommand,
  getAgentSkillTerminalShellOverride,
  getSelectedAgentRuntime,
  getSkillDiscoveryTargetForRuntime
} from './CliSkillRuntimeSetup'

function decodeWslLoginShellScript(command: string): string {
  const encoded =
    /(?:--|--exec) sh -c 'eval \\"`printf %s ([A-Za-z0-9+/=]+) \| base64 -d`\\"'/.exec(command)?.[1]
  expect(encoded).toBeDefined()
  return Buffer.from(encoded!, 'base64').toString('utf8')
}

function getWslOuterShellScript(command: string): string {
  const script = /(?:--|--exec) sh -c '([^']+)' \} # Runs:/.exec(command)?.[1]
  expect(script).toBeDefined()
  // Simulate PowerShell 5.1's native argv boundary consuming quote escapes.
  return script!.replaceAll('\\"', '"')
}

describe('CliSkillRuntimeSetup runtime helpers', () => {
  const windowsNpxPreflightPrefix = 'cmd.exe /d /s /c "where.exe npx >nul 2>nul & if errorlevel 1 ('
  const windowsNpxGuidance =
    'echo ERROR: npx was not found. Install Node.js LTS from https://nodejs.org/ to get npx. & echo Then close this terminal and start skill setup again - a new terminal picks up the updated PATH. & exit /b 1'

  it('keeps copied WSL skill installs valid for the target POSIX shell', () => {
    const skillCommand = 'npx skills add orchestration --global'
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    } as const
    const command = buildSkillInstallCommandForRuntime(skillCommand, runtime)
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')
    const encoded = Buffer.from(buildWslLoginShellCommand(skillCommand), 'utf8').toString('base64')

    expect(command).toBe(skillCommand)
    expect(setupCommand).toBe(
      `& { $PSNativeCommandArgumentPassing = 'Legacy'; wsl.exe -d 'Ubuntu' --exec sh -c 'eval \\"\`printf %s ${encoded} | base64 -d\`\\"' } # Runs: ${skillCommand}`
    )
    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills add orchestration --global\''
    )
  })

  it('keeps a Windows-selected WSL install inside WSL without the host preflight', () => {
    const skillCommand = 'npx skills add orchestration --global'
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    } as const
    const command = buildSkillCommandForRuntime(skillCommand, runtime, 'win32')
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')

    expect(command).toBe(skillCommand)
    expect(setupCommand).toContain("wsl.exe -d 'Ubuntu'")
    expect(setupCommand).not.toContain('where.exe npx')
    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills add orchestration --global\''
    )
  })

  it('wraps WSL skill updates for the selected distro setup terminal', () => {
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Fedora Remix',
      label: 'WSL Fedora Remix'
    } as const
    const command = buildSkillCommandForRuntime('npx skills update orchestration --global', runtime)
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')

    expect(decodeWslLoginShellScript(setupCommand)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills update orchestration --global\''
    )
  })

  it('scopes the PS5-compatible argv mode in the PowerShell setup terminal', () => {
    const runtime = { runtime: 'wsl', label: 'WSL' } as const
    const command = buildSkillCommandForRuntime('npx skills update orchestration --global', runtime)
    const setupCommand = buildSkillSetupTerminalCommand(command, 'powershell.exe', runtime, 'win32')

    expect(setupCommand).toMatch(
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; wsl\.exe --exec sh -c 'eval \\"`printf/
    )
    expect(setupCommand).toContain('`\\"\' } # Runs: npx skills update orchestration --global')
  })

  it.skipIf(process.platform === 'win32')(
    'runs skill commands with npx from the configured WSL login-shell PATH',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'orca-wsl-skill-command-'))
      const tools = join(root, 'tools')
      const npxBin = join(root, 'npx-bin')
      const loginShell = join(root, 'zsh')
      mkdirSync(tools)
      mkdirSync(npxBin)
      writeFileSync(
        join(tools, 'getent'),
        '#!/bin/sh\nprintf \'%s\\n\' "user:x:1000:1000::/home/user:$ORCA_TEST_LOGIN_SHELL"\n'
      )
      writeFileSync(
        loginShell,
        '#!/bin/sh\nexport PATH="$ORCA_TEST_NPX_BIN:/usr/bin:/bin"\nexec /bin/sh -c "$2"\n'
      )
      writeFileSync(
        join(npxBin, 'npx'),
        '#!/bin/sh\nread -r input\nprintf \'%s:%s\' "$*" "$input"\n'
      )
      chmodSync(join(tools, 'getent'), 0o755)
      chmodSync(loginShell, 0o755)
      chmodSync(join(npxBin, 'npx'), 0o755)

      try {
        const runtime = {
          runtime: 'wsl',
          label: 'WSL'
        } as const
        const copied = buildSkillCommandForRuntime(
          'npx skills update orchestration --global',
          runtime
        )
        const wrapped = buildSkillSetupTerminalCommand(copied, 'powershell.exe', runtime, 'win32')
        expect(
          execFileSync('/bin/sh', ['-c', getWslOuterShellScript(wrapped)], {
            encoding: 'utf8',
            input: 'terminal-input\n',
            env: {
              ...process.env,
              PATH: `${tools}:/usr/bin:/bin`,
              ORCA_TEST_LOGIN_SHELL: loginShell,
              ORCA_TEST_NPX_BIN: npxBin
            }
          })
        ).toBe('skills update orchestration --global:terminal-input')
      } finally {
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it('preflights npx before Windows-host skill installs', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])

    expect(
      buildSkillCommandForRuntime(
        installCommand,
        {
          runtime: 'host',
          label: 'Windows'
        },
        'win32'
      )
    ).toBe(`${windowsNpxPreflightPrefix}${windowsNpxGuidance}) else (${installCommand})"`)
  })

  it('treats missing runtime as a preflighted Windows host fallback for skill installs', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration'])

    expect(buildSkillCommandForRuntime(installCommand, undefined, 'win32')).toBe(
      `${windowsNpxPreflightPrefix}${windowsNpxGuidance}) else (${installCommand})"`
    )
  })

  it('reinstalls Windows-host skill updates after the npx preflight', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])

    expect(
      buildSkillCommandForRuntime(
        'npx skills update orchestration --global',
        {
          runtime: 'host',
          label: 'Windows'
        },
        'win32'
      )
    ).toBe(`${windowsNpxPreflightPrefix}${windowsNpxGuidance}) else (${installCommand})"`)
  })

  it('treats missing runtime as a preflighted Windows host fallback for skill updates', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orca-cli'])

    expect(
      buildSkillCommandForRuntime('npx skills update orca-cli --global', undefined, 'win32')
    ).toBe(`${windowsNpxPreflightPrefix}${windowsNpxGuidance}) else (${installCommand})"`)
  })

  it('keeps non-Windows host skill installs on the direct npx path', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])

    expect(
      buildSkillCommandForRuntime(
        installCommand,
        {
          runtime: 'host',
          label: 'This device'
        },
        'linux'
      )
    ).toBe(installCommand)
  })

  it('keeps non-Windows host skill updates on the update path', () => {
    expect(
      buildSkillCommandForRuntime(
        'npx skills update orchestration --global',
        {
          runtime: 'host',
          label: 'This device'
        },
        'linux'
      )
    ).toBe('npx skills update orchestration --global')
  })

  it('skips the Windows preflight while a remote runtime environment is focused', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])
    const windowsHost = { runtime: 'host', label: 'Windows' } as const
    const previous = useAppStore.getState()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), activeRuntimeEnvironmentId: 'remote-linux' },
      runtimeEnvironments: [{ id: 'remote-linux' }] as never
    })

    try {
      // Setup terminals can spawn on the focused runtime, so cmd.exe may not exist there.
      expect(buildSkillCommandForRuntime(installCommand, windowsHost, 'win32')).toBe(installCommand)

      // Extra saved environments must not reintroduce the wrapper either.
      useAppStore.setState({
        runtimeEnvironments: [{ id: 'remote-linux' }, { id: 'other' }] as never
      })
      expect(buildSkillCommandForRuntime(installCommand, windowsHost, 'win32')).toBe(installCommand)
    } finally {
      useAppStore.setState({
        settings: previous.settings,
        runtimeEnvironments: previous.runtimeEnvironments
      })
    }
  })

  it('skips the Windows preflight when the configured Windows shell is POSIX-family', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])
    const windowsHost = { runtime: 'host', label: 'Windows' } as const
    const previous = useAppStore.getState()

    try {
      // MSYS rewrites cmd.exe's leading /d /s /c switches into drive paths, so
      // the copied command must stay bare for a Git Bash / wsl.exe paste target.
      for (const terminalWindowsShell of ['git-bash', 'C:\\Program Files\\Git\\bin\\bash.exe']) {
        useAppStore.setState({
          settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell }
        })
        expect(buildSkillCommandForRuntime(installCommand, windowsHost, 'win32')).toBe(
          installCommand
        )
      }

      // cmd-family shells still need the preflight wrapper.
      useAppStore.setState({
        settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'cmd.exe' }
      })
      expect(buildSkillCommandForRuntime(installCommand, windowsHost, 'win32')).toBe(
        `${windowsNpxPreflightPrefix}${windowsNpxGuidance}) else (${installCommand})"`
      )
    } finally {
      useAppStore.setState({ settings: previous.settings })
    }
  })

  it('keeps the npx preflight in the PowerShell-forced setup terminal', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])
    const windowsHost = { runtime: 'host', label: 'Windows' } as const
    const previous = useAppStore.getState()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'git-bash' }
    })

    try {
      const copied = buildSkillCommandForRuntime(installCommand, windowsHost, 'win32')
      expect(copied).toBe(installCommand)
      // Orca forces its own setup terminal to powershell.exe, where cmd.exe works.
      expect(buildSkillSetupTerminalCommand(copied, 'powershell.exe', undefined, 'win32')).toBe(
        `${windowsNpxPreflightPrefix}${windowsNpxGuidance}) else (${installCommand})"`
      )
    } finally {
      useAppStore.setState({ settings: previous.settings })
    }
  })

  it('does not re-wrap the setup terminal command when no shell override applies', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])
    const previous = useAppStore.getState()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'cmd.exe' }
    })

    try {
      const copied = buildSkillCommandForRuntime(
        installCommand,
        { runtime: 'host', label: 'Windows' },
        'win32'
      )
      expect(buildSkillSetupTerminalCommand(copied, undefined, undefined, 'win32')).toBe(copied)
      // An already-wrapped command must not gain a second preflight.
      expect(buildSkillSetupTerminalCommand(copied, 'powershell.exe', undefined, 'win32')).toBe(
        copied
      )
    } finally {
      useAppStore.setState({ settings: previous.settings })
    }
  })

  it('adapts bare WSL setup commands to the shell that Orca created', () => {
    const runtime = { runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' } as const
    const skillCommand = 'npx skills add orchestration --global'
    const copiedCommand = buildSkillCommandForRuntime(skillCommand, runtime, 'win32')

    expect(copiedCommand).toBe(skillCommand)
    expect(
      buildSkillSetupTerminalCommand(copiedCommand, 'powershell.exe', runtime, 'win32')
    ).toContain("wsl.exe -d 'Ubuntu'")
    expect(buildSkillSetupTerminalCommand(copiedCommand, 'wsl.exe', runtime, 'win32')).toBe(
      skillCommand
    )
    expect(
      buildSkillSetupTerminalCommand(
        'npx skills add orchestration --global',
        undefined,
        undefined,
        'linux'
      )
    ).toBe('npx skills add orchestration --global')
  })

  it('preserves the exact WSL script when adapting setup-terminal auto-paste', () => {
    const skillCommand = "printf 'héllo\n# Runs: unchanged'"
    const runtime = {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    } as const
    const copiedCommand = buildSkillCommandForRuntime(skillCommand, runtime)
    const powershellCommand = buildSkillSetupTerminalCommand(
      copiedCommand,
      'powershell.exe',
      runtime,
      'win32'
    )

    expect(buildSkillSetupTerminalCommand(powershellCommand, 'wsl.exe', runtime, 'win32')).toBe(
      buildWslLoginShellCommand(skillCommand)
    )
  })

  it('keeps the bare reinstall rewrite for POSIX-family Windows skill updates', () => {
    const installCommand = buildAgentFeatureSkillInstallCommand(['orchestration'])
    const previous = useAppStore.getState()
    useAppStore.setState({
      settings: { ...getDefaultSettings('/tmp'), terminalWindowsShell: 'git-bash' }
    })

    try {
      expect(
        buildSkillCommandForRuntime(
          'npx skills update orchestration --global',
          { runtime: 'host', label: 'Windows' },
          'win32'
        )
      ).toBe(installCommand)
    } finally {
      useAppStore.setState({ settings: previous.settings })
    }
  })

  it('does not wrap unrelated Windows host commands', () => {
    expect(
      buildSkillCommandForRuntime(
        'orca skills list',
        {
          runtime: 'host',
          label: 'Windows'
        },
        'win32'
      )
    ).toBe('orca skills list')
  })

  it('emits a cmd.exe payload that cannot break its own if/else block', () => {
    const wrapped = buildSkillCommandForRuntime(
      buildAgentFeatureSkillInstallCommand(['orca-cli', 'orchestration']),
      { runtime: 'host', label: 'Windows' },
      'win32'
    )

    // cmd.exe /s strips only the first and last quote and passes the rest verbatim.
    expect(wrapped.match(/"/g)).toHaveLength(2)
    const blocks = /if errorlevel 1 \((.*)\) else \((.*)\)"$/.exec(wrapped)
    expect(blocks).not.toBeNull()
    for (const block of [blocks![1], blocks![2]]) {
      // Any of these would close the block early or redirect inside cmd.exe.
      expect(block).not.toMatch(/[()"%!^|<>]/)
    }
  })

  it('forces PowerShell for the skill terminal when Windows runs a POSIX-family shell', () => {
    const hostRuntime = { runtime: 'host', label: 'Windows' } as const
    const overrideFor = (terminalWindowsShell: string): string | undefined =>
      getAgentSkillTerminalShellOverride(
        'win32',
        { ...getDefaultSettings('/tmp'), terminalWindowsShell },
        hostRuntime
      )

    // Git Bash rewrites the leading /d /s /c arguments as MSYS paths.
    expect(overrideFor('git-bash')).toBe('powershell.exe')
    expect(overrideFor('wsl.exe')).toBe('powershell.exe')
    expect(overrideFor('cmd.exe')).toBeUndefined()
    expect(overrideFor('powershell.exe')).toBeUndefined()
  })

  it('preserves the selected WSL distro for skill discovery', () => {
    expect(
      getSkillDiscoveryTargetForRuntime({
        runtime: 'wsl',
        wslDistro: 'Ubuntu',
        label: 'WSL Ubuntu'
      })
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu' })
  })

  it('uses the global project runtime default instead of stale WSL agent location', () => {
    expect(
      getSelectedAgentRuntime(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'wsl',
          localAgentWslDistro: 'Debian',
          terminalWindowsShell: 'wsl.exe',
          terminalWindowsWslDistro: 'Debian',
          localWindowsRuntimeDefault: { kind: 'windows-host' }
        },
        true,
        true,
        false
      )
    ).toMatchObject({ runtime: 'host' })
  })

  it('uses the WSL global project runtime default instead of stale host agent location', () => {
    expect(
      getSelectedAgentRuntime(
        {
          ...getDefaultSettings('/tmp'),
          localAgentRuntime: 'host',
          terminalWindowsShell: 'powershell.exe',
          localWindowsRuntimeDefault: { kind: 'wsl', distro: 'Ubuntu' }
        },
        true,
        true,
        false
      )
    ).toEqual({ runtime: 'wsl', wslDistro: 'Ubuntu', label: 'WSL Ubuntu' })
  })
})
