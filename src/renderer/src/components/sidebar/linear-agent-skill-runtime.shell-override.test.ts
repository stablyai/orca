import { describe, expect, it } from 'vitest'
import {
  getLinearPromptAgentRuntime,
  getLinearPromptTerminalShellOverride,
  resolveLinearSkillCommandPlatform
} from './linear-agent-skill-runtime'

const hostRuntime = { runtime: 'host', label: 'Windows' } as const

describe('resolveLinearSkillCommandPlatform', () => {
  it('keeps local UI viewer-owned and remote commands execution-host-owned', () => {
    expect(
      resolveLinearSkillCommandPlatform({
        executionHostPlatform: 'linux',
        remote: false,
        webClient: false,
        viewerPlatform: 'win32'
      })
    ).toBe('win32')
    for (const remote of [false, true]) {
      expect(
        resolveLinearSkillCommandPlatform({
          executionHostPlatform: 'linux',
          remote,
          webClient: !remote,
          viewerPlatform: 'win32'
        })
      ).toBe('linux')
    }
  })

  it('keeps unknown remote truth neutral and respects explicit test/platform ownership', () => {
    expect(
      resolveLinearSkillCommandPlatform({ remote: true, webClient: false, viewerPlatform: 'win32' })
    ).toBeUndefined()
    expect(
      resolveLinearSkillCommandPlatform({
        explicitPlatform: 'darwin',
        executionHostPlatform: 'linux',
        remote: true,
        webClient: false,
        viewerPlatform: 'win32'
      })
    ).toBe('darwin')
  })
})

describe('getLinearPromptTerminalShellOverride', () => {
  // Why: this prompt pastes the same generated Windows command as the settings
  // panes, and Git Bash rewrites its leading /d /s /c arguments as MSYS paths.
  it('forces PowerShell for POSIX-family Windows shells', () => {
    for (const terminalWindowsShell of ['git-bash', 'wsl.exe']) {
      expect(
        getLinearPromptTerminalShellOverride('win32', { terminalWindowsShell }, hostRuntime)
      ).toBe('powershell.exe')
    }
  })

  it('leaves cmd and PowerShell shells alone, and never overrides off Windows', () => {
    expect(
      getLinearPromptTerminalShellOverride(
        'win32',
        { terminalWindowsShell: 'cmd.exe' },
        hostRuntime
      )
    ).toBeUndefined()
    expect(
      getLinearPromptTerminalShellOverride(
        'darwin',
        { terminalWindowsShell: 'git-bash' },
        hostRuntime
      )
    ).toBeUndefined()
  })
})

describe('getLinearPromptAgentRuntime', () => {
  it('carries the command owner platform for host and WSL runtimes', () => {
    expect(getLinearPromptAgentRuntime(null, 'linux', true)).toMatchObject({
      runtime: 'host',
      hostPlatform: 'linux'
    })
    expect(
      getLinearPromptAgentRuntime(
        { localAgentRuntime: 'wsl', terminalWindowsShell: 'powershell.exe' },
        'win32',
        false
      )
    ).toMatchObject({
      runtime: 'wsl',
      hostPlatform: 'win32'
    })
  })

  it('preserves complete execution-host shell authority', () => {
    const executionHostRuntime = {
      runtime: 'host' as const,
      hostPlatform: 'win32' as const,
      terminalWindowsShell: 'git-bash',
      label: 'Windows'
    }

    expect(getLinearPromptAgentRuntime(null, 'linux', true, undefined, executionHostRuntime)).toBe(
      executionHostRuntime
    )
  })

  it('keeps an explicit project WSL target ahead of active host metadata', () => {
    expect(
      getLinearPromptAgentRuntime(
        null,
        'win32',
        false,
        {
          status: 'resolved',
          runtime: {
            kind: 'wsl',
            hostPlatform: 'wsl',
            projectId: 'project-1',
            distro: 'Fedora',
            reason: 'project-override',
            cacheKey: 'wsl:Fedora'
          }
        },
        { runtime: 'host', hostPlatform: 'linux', label: 'This device' }
      )
    ).toMatchObject({ runtime: 'wsl', wslDistro: 'Fedora', hostPlatform: 'win32' })
  })
})
