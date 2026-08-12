import { describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import { getCodexSelectionLaneKey } from '../../../shared/codex-selection-lane'
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
}): LaneState {
  return {
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

/** The Windows-only shell resolution is gated on the renderer platform. */
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

  // Why this matters: pty.ts keys such a pane `wsl:<distro>` from the resolved
  // runtime, so keying it `wsl:__default__` would make its own distro's switch
  // miss it — the pane keeps the old account with no notice.
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

  // Why: main resolves the shell through resolveLocalWindowsTerminalRuntimeOptions,
  // so an unset override still lands on WSL when that is the Windows default.
  // Reading only the tab would key this pane `host` and mute it on a host switch.
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

  // Why: the startup cwd is deliberately unconstrained (#7685), and main keys
  // the lane off it, so a pane split across filesystems must follow the cwd.
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

  // Why: a floating terminal's cwd never reaches the tab, so it is keyed by its
  // shell. Pinning that it does not throw or resolve against some other
  // workspace's root, which is what the lane would otherwise inherit.
  it('keys a floating terminal by its shell, not another workspace root', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ worktreePath: '\\\\wsl.localhost\\Ubuntu\\home\\dev' }),
        tab: { worktreeId: 'global-floating-terminal', shellOverride: undefined },
        ptyId: 'pty-1'
      })
    ).toBe('host')
  })

  // Why: resolveLocalWindowsTerminalRuntimeOptions THROWS on repair-required,
  // and this runs outside scanCodexPanes' per-pane failure guard — so without
  // the early return the Promise.all rejects and EVERY pane in the batch loses
  // its notice, not just this one.
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

  it('routes an owner-less remote pane to the active environment, as inspection does', () => {
    expect(
      resolveCodexPaneSelectionLaneKey({
        state: laneState({ activeRuntimeEnvironmentId: 'env-1' }),
        tab: HOST_TAB,
        ptyId: 'remote:term-1'
      })
    ).toBe('env:env-1')
  })

  it('keeps an owner-less remote pane off the host lane when no environment is active', () => {
    const laneKey = resolveCodexPaneSelectionLaneKey({
      state: laneState(),
      tab: HOST_TAB,
      ptyId: 'remote:term-1'
    })
    // Why assert disjointness rather than the literal key: colliding with `host`
    // is the whole failure mode — a local switch would mute a working remote pane.
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
    // Why: managed Codex accounts are only ever 'host' or 'wsl:<distro>', so no
    // switch can produce this key — the pane is unreachable by any selection.
    expect(laneKey).not.toBe(getCodexSelectionLaneKey({ runtime: 'host' }))
    expect(isLocalCodexSelectionLaneKey(laneKey)).toBe(false)
  })
})

describe('resolveCodexPaneSelectionLane', () => {
  it('prefers the lane main recorded at spawn over the current derivation', () => {
    // Why this is the whole point: the derivation reads CURRENT state, so the
    // user editing a runtime preference after the pane opened must not re-key it.
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

  // THE regression that matters: over-filtering silently kills the feature.
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
    // Why: the registry accepts any string it finds on disk, and a lane key that
    // matches no switch would silently drop the pane's notice instead of failing.
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
    // Why: a foreign pane's lane is settled by its id, so a record here can only
    // be a recycled id — and honouring it would mute a working remote terminal.
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
        return Reflect.get(target, property)
      }
    }) as LaneState
    // Why: this call sits outside the scan's per-pane failure guard, so a throw
    // would lose the notice for every pane in the batch, not just this one.
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
      settings: null,
      target: { runtime: 'host' }
    })
    expect(hostSwitch('host')).toBe(true)
    expect(hostSwitch('wsl:Ubuntu')).toBe(false)

    const ubuntuSwitch = getCodexAccountSwitchLaneMatcher({
      settings: null,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' }
    })
    expect(ubuntuSwitch('wsl:Ubuntu')).toBe(true)
    expect(ubuntuSwitch('wsl:Debian')).toBe(false)
    expect(ubuntuSwitch('host')).toBe(false)
  })

  // Why a family: clearing a distro-less WSL selection nulls EVERY wsl slot, so
  // matching only `wsl:__default__` would leave those panes stranded, unnoticed.
  it('claims every WSL distro when the change cleared them all', () => {
    const wslDefaultSwitch = getCodexAccountSwitchLaneMatcher({
      settings: null,
      target: { runtime: 'wsl', wslDistro: null },
      clearsEveryWslDistro: true
    })
    expect(wslDefaultSwitch('wsl:__default__')).toBe(true)
    expect(wslDefaultSwitch('wsl:Ubuntu')).toBe(true)
    expect(wslDefaultSwitch('wsl:Debian')).toBe(true)
    // Still cannot reach another machine, which is the point of the guard.
    expect(wslDefaultSwitch('host')).toBe(false)
    expect(wslDefaultSwitch('env:env-1')).toBe(false)
    expect(wslDefaultSwitch('ssh-connection')).toBe(false)
    expect(wslDefaultSwitch('remote-runtime')).toBe(false)
  })

  // Why the negative half matters: pointing a distro-less WSL row at a real
  // account writes only the `__default__` slot, so claiming the family there
  // would card — and mute — every sibling distro's healthy Codex pane.
  it('keeps a distro-less WSL selection off sibling distro panes', () => {
    const wslDefaultSelect = getCodexAccountSwitchLaneMatcher({
      settings: null,
      target: { runtime: 'wsl', wslDistro: null }
    })
    expect(wslDefaultSelect('wsl:__default__')).toBe(true)
    expect(wslDefaultSelect('wsl:Ubuntu')).toBe(false)
    expect(wslDefaultSelect('host')).toBe(false)
  })

  // Why: StatusBar passes clearsEveryWslDistro for the "System default" row of
  // EVERY WSL group, including a concrete-distro one, where the clear lands in
  // that slot alone. Without the null-distro condition it would mute them all.
  it('keeps a cleared concrete-distro row off the other distros', () => {
    const ubuntuClear = getCodexAccountSwitchLaneMatcher({
      settings: null,
      target: { runtime: 'wsl', wslDistro: 'Ubuntu' },
      clearsEveryWslDistro: true
    })
    expect(ubuntuClear('wsl:Ubuntu')).toBe(true)
    expect(ubuntuClear('wsl:Debian')).toBe(false)
    expect(ubuntuClear('wsl:__default__')).toBe(false)
  })

  it('scopes a switch made against a runtime environment to that machine', () => {
    const environmentSwitch = getCodexAccountSwitchLaneMatcher({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      target: { runtime: 'host' }
    })
    expect(environmentSwitch('env:env-1')).toBe(true)
    expect(environmentSwitch('host')).toBe(false)
    expect(environmentSwitch('env:env-2')).toBe(false)
  })

  it('never lets a local host switch claim a remote or SSH pane', () => {
    const hostSwitch = getCodexAccountSwitchLaneMatcher({
      settings: null,
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
