import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TerminalTabIntoPaneState } from './terminal-tab-into-pane-eligibility'
import {
  isSourceWideRefusal,
  resolveTerminalTabIntoPaneEligibility
} from './terminal-tab-into-pane-eligibility'
import {
  holdTerminalMoveKeys,
  terminalLeafMoveKey,
  terminalTabMoveKey
} from './terminal-leaf-move-guard'
import {
  A,
  B,
  C,
  intoPaneState,
  P_A,
  SOURCE,
  sourceLayout,
  targetLayout,
  TARGET,
  terminalTab,
  WT
} from './terminal-tab-into-pane-fixture'

// Pinned off so the window-applied rules run in a layout-owner test run too; one block turns it on.
const layoutOwner = vi.hoisted(() => ({ isMain: false }))
vi.mock('../../../../shared/layout-owner-switch', () => ({
  get ORCA_LAYOUT_OWNER_IS_MAIN() {
    return layoutOwner.isMain
  }
}))
beforeEach(() => {
  layoutOwner.isMain = false
})

const args = { sourceTabId: SOURCE, targetTabId: TARGET, isWebClient: false }

function refusal(
  state: TerminalTabIntoPaneState,
  patch: Partial<typeof args> & { targetLeafId?: string } = {}
) {
  const result = resolveTerminalTabIntoPaneEligibility(state, { ...args, ...patch })
  return result.ok ? 'eligible' : result.reason
}

describe('resolveTerminalTabIntoPaneEligibility (spec 4.3)', () => {
  it('accepts a single-pane source and resolves the target active leaf', () => {
    expect(resolveTerminalTabIntoPaneEligibility(intoPaneState(), args)).toEqual({
      ok: true,
      worktreeId: WT,
      leafId: A,
      ptyId: P_A,
      targetLeafId: C
    })
  })

  it('honors an explicit target leaf and refuses one the target does not hold', () => {
    const ok = resolveTerminalTabIntoPaneEligibility(intoPaneState(), { ...args, targetLeafId: B })
    expect(ok).toMatchObject({ ok: true, targetLeafId: B })
    expect(refusal(intoPaneState(), { targetLeafId: 'missing' })).toBe('target_pane_missing')
  })

  it('falls back to tab.ptyId when the layout has no binding for the leaf', () => {
    const layout = { ...sourceLayout(), ptyIdsByLeafId: {} }
    const state = intoPaneState({
      terminalLayoutsByTabId: { [SOURCE]: layout, [TARGET]: targetLayout() }
    })
    expect(resolveTerminalTabIntoPaneEligibility(state, args)).toMatchObject({
      ok: true,
      ptyId: P_A
    })
  })

  it('refuses the same tab, a missing tab and another worktree', () => {
    expect(refusal(intoPaneState(), { targetTabId: SOURCE })).toBe('same_tab')
    expect(refusal(intoPaneState(), { sourceTabId: 'gone' })).toBe('source_missing')
    expect(refusal(intoPaneState(), { targetTabId: 'gone' })).toBe('target_missing')
    const other = intoPaneState({
      tabsByWorktree: {
        [WT]: [terminalTab(SOURCE, P_A)],
        'repo1::/other': [terminalTab(TARGET, 'pty-b', { worktreeId: 'repo1::/other' })]
      }
    })
    expect(refusal(other)).toBe('worktree_mismatch')
  })

  it('refuses a source whose layout is not exactly one leaf', () => {
    const state = intoPaneState({
      terminalLayoutsByTabId: { [SOURCE]: targetLayout(), [TARGET]: targetLayout() }
    })
    expect(refusal(state)).toBe('source_not_single_pane')
  })

  it('refuses a chat source, a chat leaf and a chat target', () => {
    const chatTab = intoPaneState({
      tabsByWorktree: {
        [WT]: [terminalTab(SOURCE, P_A, { viewMode: 'chat' }), terminalTab(TARGET, 'pty-b')]
      }
    })
    expect(refusal(chatTab)).toBe('source_chat')
    const chatLeaf = intoPaneState({
      terminalLayoutsByTabId: {
        [SOURCE]: { ...sourceLayout(), chatLeafId: A },
        [TARGET]: targetLayout()
      }
    })
    expect(refusal(chatLeaf)).toBe('source_chat')
    const chatTarget = intoPaneState({
      tabsByWorktree: {
        [WT]: [terminalTab(SOURCE, P_A), terminalTab(TARGET, 'pty-b', { viewMode: 'chat' })]
      }
    })
    expect(refusal(chatTarget)).toBe('target_chat')
  })

  it('reports the source refusal before a chat-view target', () => {
    const state = intoPaneState({
      pendingPtyShutdownIds: { [P_A]: 1 },
      tabsByWorktree: {
        [WT]: [terminalTab(SOURCE, P_A), terminalTab(TARGET, 'pty-b', { viewMode: 'chat' })]
      }
    })
    expect(refusal(state)).toBe('pty_exiting')
  })

  it('refuses a source with no PTY', () => {
    const state = intoPaneState({
      tabsByWorktree: { [WT]: [terminalTab(SOURCE, null), terminalTab(TARGET, 'pty-b')] },
      terminalLayoutsByTabId: {
        [SOURCE]: { ...sourceLayout(), ptyIdsByLeafId: {} },
        [TARGET]: targetLayout()
      }
    })
    expect(refusal(state)).toBe('no_terminal')
  })

  it('refuses a pending spawn, an unfinished agent launch and a PTY that is shutting down', () => {
    const spawn = intoPaneState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, P_A, { pendingActivationSpawn: true }),
          terminalTab(TARGET, 'pty-b')
        ]
      }
    })
    expect(refusal(spawn)).toBe('pending_spawn')
    const launch = intoPaneState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, P_A, { agentLaunchPane: { leafId: A } }),
          terminalTab(TARGET, 'pty-b')
        ]
      }
    })
    expect(refusal(launch)).toBe('launch_pending')
    const finished = intoPaneState({
      tabsByWorktree: {
        [WT]: [
          terminalTab(SOURCE, P_A, {
            agentLaunchPane: { leafId: A, outcome: { kind: 'unconfirmed' } }
          }),
          terminalTab(TARGET, 'pty-b')
        ]
      }
    })
    expect(refusal(finished)).toBe('eligible')
    expect(refusal(intoPaneState({ pendingPtyShutdownIds: { [P_A]: 1 } }))).toBe('pty_exiting')
  })

  it('refuses a sleeping record at the source pane key', () => {
    const state = intoPaneState({
      sleepingAgentSessionsByPaneKey: {
        [`${SOURCE}:${A}`]: {
          paneKey: `${SOURCE}:${A}`,
          tabId: SOURCE,
          worktreeId: WT,
          agent: 'codex',
          providerSession: { key: 'session_id', id: 's' },
          prompt: 'p',
          state: 'working',
          capturedAt: 1,
          updatedAt: 1
        }
      }
    })
    expect(refusal(state)).toBe('sleeping')
  })

  it.each([
    ['pendingStartupByTabId', { pendingStartupByTabId: { [SOURCE]: { command: 'claude' } } }],
    [
      'automaticAgentResumeClaimsByTabId',
      {
        automaticAgentResumeClaimsByTabId: {
          [SOURCE]: {
            worktreeId: WT,
            launchAgent: 'claude',
            providerSession: { key: 'session_id', id: 's' }
          }
        }
      }
    ],
    ['pendingInitialCwdByTabId', { pendingInitialCwdByTabId: { [SOURCE]: '/tmp' } }],
    [
      'pendingIssueCommandSplitByTabId',
      { pendingIssueCommandSplitByTabId: { [SOURCE]: { command: 'x' } } }
    ]
  ] satisfies [string, Partial<TerminalTabIntoPaneState>][])(
    'refuses a source with %s queued (closeTab would drop it)',
    (_field, patch) => {
      expect(refusal(intoPaneState(patch))).toBe('startup_pending')
    }
  )

  it('refuses a source in unverifiedPtyLossTabIds', () => {
    expect(refusal(intoPaneState({ unverifiedPtyLossTabIds: { [SOURCE]: true } }))).toBe(
      'unverified_pty_loss'
    )
  })

  it('refuses a web client and any remote-runtime PTY in the source or the target', () => {
    expect(refusal(intoPaneState(), { isWebClient: true })).toBe('host_authoritative')
    const remoteSource = intoPaneState({
      terminalLayoutsByTabId: {
        [SOURCE]: { ...sourceLayout(), ptyIdsByLeafId: { [A]: 'remote:env-1@@terminal-1' } },
        [TARGET]: targetLayout()
      }
    })
    expect(refusal(remoteSource)).toBe('host_authoritative')
    const remoteTarget = intoPaneState({
      terminalLayoutsByTabId: {
        [SOURCE]: sourceLayout(),
        [TARGET]: {
          ...targetLayout(),
          ptyIdsByLeafId: { [B]: 'remote:env-1@@terminal-2', [C]: 'pty-c' }
        }
      }
    })
    expect(refusal(remoteTarget)).toBe('host_authoritative')
  })

  describe('move in flight', () => {
    let release: (() => void) | null = null
    afterEach(() => release?.())

    it('refuses while the leaf is held by another move', () => {
      release = holdTerminalMoveKeys([terminalLeafMoveKey(A)])
      expect(refusal(intoPaneState())).toBe('move_in_flight')
    })

    it('refuses while either tab is held, and accepts once released', () => {
      release = holdTerminalMoveKeys([terminalTabMoveKey(TARGET)])
      expect(refusal(intoPaneState())).toBe('move_in_flight')
      release?.()
      release = holdTerminalMoveKeys([terminalTabMoveKey(SOURCE)])
      expect(refusal(intoPaneState())).toBe('move_in_flight')
      release?.()
      release = null
      expect(refusal(intoPaneState())).toBe('eligible')
    })
  })

  it('does not refuse for unknown liveness: a PTY with no exit evidence stays eligible', () => {
    expect(refusal(intoPaneState({ pendingPtyShutdownIds: { [C]: 1 } }))).toBe('eligible')
  })
})

describe('in a layout-owner build', () => {
  it('refuses every join first, whatever else would also refuse', () => {
    layoutOwner.isMain = true

    expect(refusal(intoPaneState())).toBe('layout_owner_build')
    expect(refusal(intoPaneState(), { targetTabId: SOURCE })).toBe('layout_owner_build')
    expect(refusal(intoPaneState({ tabsByWorktree: {} }))).toBe('layout_owner_build')
  })

  it('is a source-wide refusal, so the menu shows one reason for every target', () => {
    expect(isSourceWideRefusal('layout_owner_build')).toBe(true)
  })
})
