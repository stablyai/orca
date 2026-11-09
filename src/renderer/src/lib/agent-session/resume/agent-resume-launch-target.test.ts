import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentResumeLaunchTargetArgs } from './agent-resume-launch-target'

function setNavigatorUserAgent(userAgent: string): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: {
      platform: userAgent.includes('Windows') ? 'Win32' : 'MacIntel',
      userAgent
    }
  })
  return () => {
    if (original) {
      Object.defineProperty(globalThis, 'navigator', original)
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator
    }
  }
}

const LOCAL_WINDOWS_ARGS: AgentResumeLaunchTargetArgs = {
  projectRuntime: undefined,
  connectionId: null,
  executionHostId: 'local',
  worktreePath: 'C:\\Users\\neil\\orca\\workspaces\\orca\\feature',
  terminalWindowsShell: null
}

async function resolveWith(
  overrides: Partial<AgentResumeLaunchTargetArgs>
): Promise<{ platform: NodeJS.Platform; shell: string | undefined }> {
  const { resolveAgentResumeLaunchTarget } = await import('./agent-resume-launch-target')
  const { platform, shell } = resolveAgentResumeLaunchTarget({
    ...LOCAL_WINDOWS_ARGS,
    ...overrides
  })
  return { platform, shell }
}

describe('resolveAgentResumeLaunchTarget on a Windows client', () => {
  let restoreNavigator = (): void => {}

  beforeAll(() => {
    vi.resetModules()
  })

  beforeEach(() => {
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  // Why: an older server omits its OS, but its drive-letter workspace path still proves Windows.
  it('keeps Windows quoting for an older Windows server that does not report its OS', async () => {
    await expect(
      resolveWith({ executionHostId: 'runtime:prod-box', worktreePath: 'C:\\srv\\repo' })
    ).resolves.toEqual({ platform: 'win32', shell: undefined })
  })
})

describe('resolveAgentResumeLaunchTarget off Windows', () => {
  let restoreNavigator = (): void => {}

  beforeEach(() => {
    vi.resetModules()
    restoreNavigator = setNavigatorUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')
  })

  afterEach(() => {
    restoreNavigator()
  })

  it('quotes a nested SSH target on a Windows paired server for that target, not the server', async () => {
    await expect(
      resolveWith({
        connectionId: 'ssh-nested',
        executionHostId: 'runtime:prod-box',
        worktreePath: '/home/neil/repo',
        runtimeHostPlatform: 'win32'
      })
    ).resolves.toEqual({ platform: 'linux', shell: undefined })
  })
})

// Why: a paired server's nested SSH target runs the command, so its own reported OS decides quoting.
describe('resolveSshHostReportedPlatform for a nested SSH target', () => {
  it('reads the target the server reaches, not the server', async () => {
    const { resolveSshHostReportedPlatform } = await import('./agent-resume-launch-target')
    const state = {
      sshConnectionStates: new Map(),
      sshStateByEnvironment: new Map([
        [
          'prod-box',
          {
            connectionStates: new Map([
              [
                'ssh-nested',
                {
                  targetId: 'ssh-nested',
                  status: 'connected' as const,
                  error: null,
                  reconnectAttempt: 0,
                  remotePlatform: 'win32' as const
                }
              ]
            ]),
            targetLabels: new Map(),
            targetGenerations: new Map(),
            removedTargetLabels: new Map(),
            targetsHydrated: true
          }
        ]
      ])
    }
    expect(resolveSshHostReportedPlatform(state, 'runtime:prod-box', null, 'ssh-nested')).toBe(
      'win32'
    )
    expect(resolveSshHostReportedPlatform(state, 'runtime:prod-box', null, null)).toBeNull()
  })
})
