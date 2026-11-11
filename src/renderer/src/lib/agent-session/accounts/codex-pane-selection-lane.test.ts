import { describe, expect, it } from 'vitest'
import {
  getCodexAccountSwitchLaneMatcher,
  resolveCodexPaneSelectionLane,
  resolveCodexPaneSelectionLaneKey
} from './codex-pane-selection-lane'
import type { AppState } from '@/store/types'

type LaneState = Pick<
  AppState,
  | 'activeRepoId'
  | 'activeWorktreeId'
  | 'folderWorkspaces'
  | 'projects'
  | 'repos'
  | 'runtimeEnvironments'
  | 'settings'
  | 'worktreesByRepo'
>

function laneState(args?: {
  activeRuntimeEnvironmentId?: string | null
  worktreePath?: string
  folderPath?: string
  terminalWindowsShell?: string
  terminalWindowsWslDistro?: string | null
  projectWslDistro?: string
  localWindowsRuntimeDefault?: { kind: 'wsl'; distro: string | null }
  wslHost?: { environmentId: string; distro: string }
}): LaneState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the lane reads only the fields set here.
  return {
    runtimeEnvironments: args?.wslHost
      ? [
          {
            id: args.wslHost.environmentId,
            orcadDeployment: {
              kind: 'wsl',
              distro: args.wslHost.distro,
              localPort: 41000,
              remotePort: 41001
            }
          }
        ]
      : [],
    folderWorkspaces: args?.folderPath ? [{ id: 'fw1', folderPath: args.folderPath }] : [],
    settings: {
      activeRuntimeEnvironmentId: args?.activeRuntimeEnvironmentId ?? null,
      ...(args?.terminalWindowsShell ? { terminalWindowsShell: args.terminalWindowsShell } : {}),
      ...(args?.localWindowsRuntimeDefault
        ? { localWindowsRuntimeDefault: args.localWindowsRuntimeDefault }
        : {}),
      terminalWindowsWslDistro: args?.terminalWindowsWslDistro ?? null
    },
    repos: [{ id: 'repo1', path: 'C:\\code\\app' }],
    projects: args?.projectWslDistro
      ? [
          {
            id: 'proj1',
            sourceRepoIds: ['repo1'],
            localWindowsRuntimePreference: { kind: 'wsl', distro: args.projectWslDistro }
          }
        ]
      : [],
    worktreesByRepo: {
      repo1: [{ id: 'wt1', repoId: 'repo1', path: args?.worktreePath ?? '/Users/dev/code/orca' }]
    }
  } as unknown as LaneState
}

function withWindowsRenderer(run: () => void): void {
  const originalNavigator = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    value: { userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
    configurable: true
  })
  try {
    run()
  } finally {
    Object.defineProperty(globalThis, 'navigator', {
      value: originalNavigator,
      configurable: true
    })
  }
}

const HOST_TAB = { worktreeId: 'wt1', shellOverride: undefined }

describe('resolveCodexPaneSelectionLaneKey', () => {
  // Startup cwd can leave the worktree (#7685); lane derivation must follow its filesystem like main.
  it('follows the pane startup cwd out of the workspace filesystem', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ worktreePath: 'C:\\code\\app' }),
        tab: {
          worktreeId: 'wt1',
          shellOverride: undefined,
          startupCwd: '\\\\wsl.localhost\\Ubuntu\\home\\dev'
        },
        ptyId: 'pty-1'
      })
    ).toBe('wsl:Ubuntu')
  })

  // Repair-required resolution throws outside the per-pane guard; return early or one pane loses the entire batch’s notices.
  it('answers a repair-required runtime instead of throwing the batch away', () => {
    withWindowsRenderer(() => {
      expect(
        resolveCodexPaneSelectionLaneKey({
          state: laneState({
            localWindowsRuntimeDefault: { kind: 'wsl', distro: null },
            worktreePath: 'C:\\code\\app'
          }),
          tab: HOST_TAB,
          ptyId: 'pty-1'
        })
      ).toBe('wsl:__default__')
    })
  })
})

describe('resolveCodexPaneSelectionLane', () => {
  it('prefers the lane main recorded at spawn over the current derivation', () => {
    // Current preferences can drift after spawn; a recorded lane must remain authoritative.
    const lane = resolveCodexPaneSelectionLane({
      state: laneState(),
      tab: HOST_TAB,
      ptyId: 'pty-1',
      recordedLaneKey: 'wsl:Ubuntu'
    })
    expect(lane).toEqual({
      laneKey: 'wsl:Ubuntu',
      source: 'recorded',
      derivedLaneKey: 'host'
    })
  })

  it.each([
    ['remote:env-1@@term-1', 'env:env-1'],
    ['ssh:my-box@@pty-7', 'ssh-connection']
  ])('keeps a record from re-keying the foreign pane %s', (ptyId, expectedLaneKey) => {
    // Foreign IDs determine their own lane; a recorded hit can only be a recycled ID.
    expect(
      resolveCodexPaneSelectionLane({
        state: laneState({ activeRuntimeEnvironmentId: 'env-1' }),
        tab: HOST_TAB,
        ptyId,
        recordedLaneKey: 'host'
      })
    ).toEqual({ laneKey: expectedLaneKey, source: 'derived', derivedLaneKey: expectedLaneKey })
  })

  it('still answers with the record when the derivation throws', () => {
    const exploding = new Proxy(laneState(), {
      get(target, property) {
        if (property === 'worktreesByRepo') {
          throw new Error('state read blew up')
        }
        // oxlint-disable-next-line anti-slop/no-reflect-get -- Proxy `get` trap: raw string|symbol pass-through; the receiver stays the target on purpose.
        return Reflect.get(target, property)
      }
    })
    // Derivation runs outside the per-pane guard; a throw would lose the whole batch’s notices.
    expect(
      resolveCodexPaneSelectionLane({
        state: exploding,
        tab: HOST_TAB,
        ptyId: 'pty-1',
        recordedLaneKey: 'host'
      })
    ).toEqual({ laneKey: 'host', source: 'recorded', derivedLaneKey: null })
  })
})

describe('getCodexAccountSwitchLaneMatcher', () => {
  // Clearing a distro-less selection clears every WSL slot; matching only __default__ would miss them.
  it('claims every WSL distro when the change cleared them all', () => {
    const wslDefaultSwitch = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'local' },
      target: { runtime: 'wsl', wslDistro: null },
      clearsEveryWslDistro: true
    })
    expect(wslDefaultSwitch('wsl:__default__')).toBe(true)
    expect(wslDefaultSwitch('wsl:Ubuntu')).toBe(true)
    expect(wslDefaultSwitch('wsl:Debian')).toBe(true)
    expect(wslDefaultSwitch('host')).toBe(false)
    expect(wslDefaultSwitch('env:env-1')).toBe(false)
    expect(wslDefaultSwitch('ssh-connection')).toBe(false)
    expect(wslDefaultSwitch('remote-runtime')).toBe(false)
  })
})
