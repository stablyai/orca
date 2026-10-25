import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { getCodexSelectionLaneKey } from '../../../shared/codex-selection-lane'
import { toRemoteRuntimePtyId } from '../../../shared/remote-runtime-pty-id'
import {
  getCodexAccountSwitchLaneMatcher,
  isForeignMachineCodexPtyId,
  isLocalCodexSelectionLaneKey,
  resolveCodexPaneSelectionLane,
  resolveCodexPaneSelectionLaneKey
} from './codex-pane-selection-lane'

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
  it('keys an ordinary local pane to the host lane', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({ state: laneState(), tab: HOST_TAB, ptyId: 'pty-1' })
    ).toBe('host')
  })

  it('keys a pane in a WSL UNC worktree to that distro lane', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev\\orca' }),
        tab: HOST_TAB,
        ptyId: 'pty-1'
      })
    ).toBe('wsl:Ubuntu')
  })

  it('keys a wsl.exe pane outside a UNC worktree to the default WSL lane', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState(),
        tab: { worktreeId: 'wt1', shellOverride: 'wsl.exe' },
        ptyId: 'pty-1'
      })
    ).toBe('wsl:__default__')
  })

  // Use the resolved distro lane; wsl:__default__ would miss that distro’s account switch.
  it('keys a wsl.exe pane on a Windows-path worktree to the configured distro', () => {
    withWindowsRenderer(() => {
      expect(
        resolveCodexPaneSelectionLaneKey({
          state: laneState({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: 'Ubuntu',
            worktreePath: 'C:\\code\\app'
          }),
          tab: { worktreeId: 'wt1', shellOverride: 'wsl.exe' },
          ptyId: 'pty-1'
        })
      ).toBe('wsl:Ubuntu')
    })
  })

  it('still keys an ordinary host pane to host when a WSL distro is configured', () => {
    withWindowsRenderer(() => {
      expect(
        resolveCodexPaneSelectionLaneKey({
          state: laneState({ terminalWindowsWslDistro: 'Ubuntu', worktreePath: 'C:\\code\\app' }),
          tab: HOST_TAB,
          ptyId: 'pty-1'
        })
      ).toBe('host')
    })
  })

  // An unset tab override may inherit global WSL; using only tab fields would mislabel it host and mute it on a host switch.
  it('keys an override-less pane by the default Windows shell', () => {
    withWindowsRenderer(() => {
      expect(
        resolveCodexPaneSelectionLaneKey({
          state: laneState({
            terminalWindowsShell: 'wsl.exe',
            terminalWindowsWslDistro: 'Ubuntu',
            worktreePath: 'C:\\code\\app'
          }),
          tab: { worktreeId: 'wt1', shellOverride: undefined },
          ptyId: 'pty-1'
        })
      ).toBe('wsl:Ubuntu')
    })
  })

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

  it("keys a pane by its own project's WSL distro", () => {
    withWindowsRenderer(() => {
      expect(
        resolveCodexPaneSelectionLaneKey({
          state: laneState({ projectWslDistro: 'Debian', worktreePath: 'C:\\code\\app' }),
          tab: HOST_TAB,
          ptyId: 'pty-1'
        })
      ).toBe('wsl:Debian')
    })
  })

  // Floating cwd is absent from tab state; use its shell rather than another workspace’s root.
  it('keys a floating terminal by its shell, not another workspace root', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev' }),
        tab: { worktreeId: 'global-floating-terminal', shellOverride: undefined },
        ptyId: 'pty-1'
      })
    ).toBe('host')
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

  it('reads the distro from a folder workspace path too', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ folderPath: '\\\\wsl$\\Debian\\srv\\app' }),
        tab: { worktreeId: 'folder:fw1', shellOverride: undefined },
        ptyId: 'pty-1'
      })
    ).toBe('wsl:Debian')
  })

  it('keys an owned remote runtime pane to its own environment, not the active one', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ activeRuntimeEnvironmentId: 'env-active' }),
        tab: HOST_TAB,
        ptyId: 'remote:env-owner@@term-1'
      })
    ).toBe('env:env-owner')
  })

  it('keys a WSL host pane to its distro lane, which the desktop selection feeds', () => {
    const state = laneState({
      wslHost: { environmentId: 'wsl:Ubuntu', distro: 'Ubuntu' }
    })
    expect(
      resolveCodexPaneSelectionLaneKey({
        state,
        tab: HOST_TAB,
        ptyId: toRemoteRuntimePtyId('term-1', 'wsl:Ubuntu')
      })
    ).toBe(getCodexSelectionLaneKey({ runtime: 'wsl', wslDistro: 'Ubuntu' }))
    expect(
      getCodexAccountSwitchLaneMatcher({
        owner: { kind: 'local' },
        target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
      })('wsl:Ubuntu')
    ).toBe(true)
  })

  it('never gives an owner-less remote pane the focused server, as inspection does not', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ activeRuntimeEnvironmentId: 'env-1' }),
        tab: HOST_TAB,
        ptyId: 'remote:term-1'
      })
    ).toBe('remote-runtime')
  })

  it('keeps an owner-less remote pane off the host lane when no environment is active', () => {
    const laneKey = resolveCodexPaneSelectionLaneKey({
      state: laneState(),
      tab: HOST_TAB,
      ptyId: 'remote:term-1'
    })
    // Assert separation from host: a local switch must never mute a remote pane.
    expect(laneKey).not.toBe(getCodexSelectionLaneKey({ runtime: 'host' }))
    expect(isLocalCodexSelectionLaneKey(laneKey)).toBe(false)
  })

  it('keys an SSH-connection pane to a lane no account selection can name', () => {
    const laneKey = resolveCodexPaneSelectionLaneKey({
      state: laneState(),
      tab: HOST_TAB,
      ptyId: 'ssh:my-box@@pty-7'
    })
    expect(laneKey).toBe('ssh-connection')
    // Only host/wsl lanes have managed selections; no switch can reach this foreign key.
    expect(laneKey).not.toBe(getCodexSelectionLaneKey({ runtime: 'host' }))
    expect(isLocalCodexSelectionLaneKey(laneKey)).toBe(false)
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

  it('reports the disagreement so a re-derivation bug stays diagnosable', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      resolveCodexPaneSelectionLane({
        state: laneState(),
        tab: HOST_TAB,
        ptyId: 'pty-1',
        recordedLaneKey: 'wsl:Ubuntu'
      })
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('[codex-lane]'),
        expect.objectContaining({ ptyId: 'pty-1', recorded: 'wsl:Ubuntu', derived: 'host' })
      )
    } finally {
      warn.mockRestore()
    }
  })

  it('stays quiet when the record and the derivation agree', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const lane = resolveCodexPaneSelectionLane({
        state: laneState(),
        tab: HOST_TAB,
        ptyId: 'pty-1',
        recordedLaneKey: 'host'
      })
      expect(lane.source).toBe('recorded')
      expect(warn).not.toHaveBeenCalled()
    } finally {
      warn.mockRestore()
    }
  })

  it('derives a local host pane that main never recorded', () => {
    for (const recordedLaneKey of [undefined, null, '', '   ']) {
      expect(
        resolveCodexPaneSelectionLane({
          state: laneState(),
          tab: HOST_TAB,
          ptyId: 'pty-1',
          recordedLaneKey
        })
      ).toEqual({ laneKey: 'host', source: 'derived', derivedLaneKey: 'host' })
    }
  })

  it('falls back to the derivation when the record names no selectable lane', () => {
    // Registry strings are untrusted on-disk values; invalid lanes would silently lose notices.
    expect(
      resolveCodexPaneSelectionLane({
        state: laneState(),
        tab: HOST_TAB,
        ptyId: 'pty-1',
        recordedLaneKey: 'env:env-1'
      })
    ).toEqual({ laneKey: 'host', source: 'derived', derivedLaneKey: 'host' })
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
  it('scopes a local switch to the runtime slot it wrote', () => {
    const hostSwitch = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'local' },
      target: { runtime: 'host' }
    })
    expect(hostSwitch('host')).toBe(true)
    expect(hostSwitch('wsl:Ubuntu')).toBe(false)

    const ubuntuSwitch = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'local' },
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    expect(ubuntuSwitch('wsl:Ubuntu')).toBe(true)
    expect(ubuntuSwitch('wsl:Debian')).toBe(false)
    expect(ubuntuSwitch('host')).toBe(false)
  })

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

  // Selecting an account on distro-less WSL writes only __default__; do not mute sibling distro panes.
  it('keeps a distro-less WSL selection off sibling distro panes', () => {
    const wslDefaultSelect = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'local' },
      target: { runtime: 'wsl', wslDistro: null }
    })
    expect(wslDefaultSelect('wsl:__default__')).toBe(true)
    expect(wslDefaultSelect('wsl:Ubuntu')).toBe(false)
    expect(wslDefaultSelect('host')).toBe(false)
  })

  // Concrete-distro System default clears only its slot even with clearsEveryWslDistro; require a null distro for family matching.
  it('keeps a cleared concrete-distro row off the other distros', () => {
    const ubuntuClear = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'local' },
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      clearsEveryWslDistro: true
    })
    expect(ubuntuClear('wsl:Ubuntu')).toBe(true)
    expect(ubuntuClear('wsl:Debian')).toBe(false)
    expect(ubuntuClear('wsl:__default__')).toBe(false)
  })

  it('scopes a switch made against a runtime environment to that machine', () => {
    const environmentSwitch = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'environment', environmentId: 'env-1' },
      target: { runtime: 'host' }
    })
    expect(environmentSwitch('env:env-1')).toBe(true)
    expect(environmentSwitch('host')).toBe(false)
    expect(environmentSwitch('env:env-2')).toBe(false)
  })

  it('never lets a local host switch claim a remote or SSH pane', () => {
    const hostSwitch = getCodexAccountSwitchLaneMatcher({
      owner: { kind: 'local' },
      target: { runtime: 'host' }
    })
    const state = laneState()
    for (const ptyId of ['remote:env-owner@@term-1', 'remote:term-1', 'ssh:my-box@@pty-7']) {
      expect(hostSwitch(resolveCodexPaneSelectionLaneKey({ state, tab: HOST_TAB, ptyId }))).toBe(
        false
      )
    }
  })
})

describe('isForeignMachineCodexPtyId', () => {
  it('separates panes whose shell runs on another machine from local ones', () => {
    expect(isForeignMachineCodexPtyId('remote:env-1@@term-1')).toBe(true)
    expect(isForeignMachineCodexPtyId('remote:term-1')).toBe(true)
    expect(isForeignMachineCodexPtyId('ssh:my-box@@pty-7')).toBe(true)
    expect(isForeignMachineCodexPtyId('pty-1')).toBe(false)
  })

  it('agrees with the lane keys, so the sweep and the scan skip the same panes', () => {
    const state = laneState({ activeRuntimeEnvironmentId: 'env-1' })
    for (const ptyId of ['remote:env-1@@term-1', 'remote:term-1', 'ssh:my-box@@pty-7', 'pty-1']) {
      expect(
        isLocalCodexSelectionLaneKey(
          resolveCodexPaneSelectionLaneKey({ state, tab: HOST_TAB, ptyId })
        )
      ).toBe(!isForeignMachineCodexPtyId(ptyId))
    }
  })
})
