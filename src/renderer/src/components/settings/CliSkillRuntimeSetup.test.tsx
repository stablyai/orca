import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import { buildAgentFeatureSkillInstallCommand } from '../../../../shared/agent-feature-install-commands'
import { buildWslLoginShellCommand } from '../../../../shared/wsl-login-shell-command'
import {
  buildSkillCommandForRuntime,
  buildSkillInstallCommandForRuntime,
  getSelectedAgentRuntime,
  getSkillDiscoveryTargetForRuntime
} from './CliSkillRuntimeSetup'

function decodeWslLoginShellScript(command: string): string {
  const encoded = /-- sh -c 'eval \\"`printf %s ([A-Za-z0-9+/=]+) \| base64 -d`\\"'/.exec(
    command
  )?.[1]
  expect(encoded).toBeDefined()
  return Buffer.from(encoded!, 'base64').toString('utf8')
}

function getWslOuterShellScript(command: string): string {
  const script = /-- sh -c '([^']+)' \} # Runs:/.exec(command)?.[1]
  expect(script).toBeDefined()
  // Simulate PowerShell 5.1's native argv boundary consuming quote escapes.
  return script!.replaceAll('\\"', '"')
}

describe('CliSkillRuntimeSetup runtime helpers', () => {
  it('wraps WSL skill installs as a directly runnable selected-distro command', () => {
    const skillCommand = 'npx skills add orchestration --global'
    const command = buildSkillInstallCommandForRuntime(skillCommand, {
      runtime: 'wsl',
      wslDistro: 'Ubuntu',
      label: 'WSL Ubuntu'
    })
    const encoded = Buffer.from(buildWslLoginShellCommand(skillCommand), 'utf8').toString('base64')

    expect(command).toBe(
      `& { $PSNativeCommandArgumentPassing = 'Legacy'; wsl.exe -d 'Ubuntu' -- sh -c 'eval \\"\`printf %s ${encoded} | base64 -d\`\\"' } # Runs: ${skillCommand}`
    )
    expect(decodeWslLoginShellScript(command)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills add orchestration --global\''
    )
  })

  it('wraps WSL skill updates as a directly runnable selected-distro command', () => {
    const command = buildSkillCommandForRuntime('npx skills update orchestration --global', {
      runtime: 'wsl',
      wslDistro: 'Fedora Remix',
      label: 'WSL Fedora Remix'
    })

    expect(decodeWslLoginShellScript(command)).toContain(
      'exec "$_orca_wsl_shell" -ilc \'npx skills update orchestration --global\''
    )
  })

  it('scopes the PS5-compatible argv mode when pasted into PowerShell 7', () => {
    const command = buildSkillCommandForRuntime('npx skills update orchestration --global', {
      runtime: 'wsl',
      label: 'WSL'
    })

    expect(command).toMatch(
      /^& \{ \$PSNativeCommandArgumentPassing = 'Legacy'; wsl\.exe -- sh -c 'eval \\"`printf/
    )
    expect(command).toContain('`\\"\' } # Runs: npx skills update orchestration --global')
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
        const wrapped = buildSkillCommandForRuntime('npx skills update orchestration --global', {
          runtime: 'wsl',
          label: 'WSL'
        })
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

  it('reinstalls Windows-host skill updates through the add path', () => {
    expect(
      buildSkillCommandForRuntime(
        'npx skills update orchestration --global',
        {
          runtime: 'host',
          label: 'Windows'
        },
        'win32'
      )
    ).toBe(buildAgentFeatureSkillInstallCommand(['orchestration']))
  })

  it('treats missing runtime as a Windows host fallback for skill updates', () => {
    expect(
      buildSkillCommandForRuntime('npx skills update orca-cli --global', undefined, 'win32')
    ).toBe(buildAgentFeatureSkillInstallCommand(['orca-cli']))
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
