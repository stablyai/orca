import { describe, expect, it } from 'vitest'
import type { SleepingAgentSessionRecord } from '../../../../shared/agent-session-resume'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import { brandEphemeralSetupTerminalWorktreeId } from '../../../../shared/ephemeral-setup-terminal-worktree-id'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import {
  buildTerminalTabRetirementPlan,
  buildTerminalTabRetirementPlans,
  isTerminalTabPresent,
  removeSleepingAgentSessionsForTab
} from './terminal-tab-retirement'

type RetirementState = Parameters<typeof buildTerminalTabRetirementPlan>[0]

function makeTab(id: string, worktreeId: string, ptyId: string | null): TerminalTab {
  return {
    id,
    worktreeId,
    ptyId,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

function makeState(overrides: Partial<RetirementState> = {}): RetirementState {
  return {
    worktreesByRepo: {
      repo: [
        { id: 'wt-1', repoId: 'repo', hostId: 'local' },
        { id: 'wt-2', repoId: 'repo', hostId: 'local' }
      ]
    },
    tabsByWorktree: {},
    unifiedTabsByWorktree: {},
    ptyIdsByTabId: {},
    terminalLayoutsByTabId: {},
    lastKnownRelayPtyIdByTabId: {},
    deferredSshSessionIdsByTabId: {},
    pendingReconnectPtyIdByTabId: {},
    ...overrides
  }
}

function makeSleepingRecord(paneKey: string, tabId?: string): SleepingAgentSessionRecord {
  return {
    paneKey,
    tabId,
    worktreeId: 'wt-1',
    agent: 'codex',
    providerSession: { key: 'session_id', id: paneKey },
    prompt: 'continue',
    state: 'working',
    capturedAt: 1,
    updatedAt: 1
  }
}

describe('terminal tab retirement planning', () => {
  it('collects and deduplicates every ownership source before routing providers', () => {
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'wt-1', 'pty-row')]
      },
      ptyIdsByTabId: { 'tab-1': ['pty-index', 'pty-row'] },
      terminalLayoutsByTabId: {
        'tab-1': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: {
            leaf1: 'pty-layout',
            leaf2: 'remote:env-1@@terminal-1'
          }
        }
      },
      lastKnownRelayPtyIdByTabId: { 'tab-1': 'ssh:ssh-1@@relay-pty' },
      deferredSshSessionIdsByTabId: { 'tab-1': 'pty-deferred' },
      pendingReconnectPtyIdByTabId: { 'tab-1': 'pty-pending' }
    })

    expect(buildTerminalTabRetirementPlan(state, 'tab-1')).toEqual({
      tabId: 'tab-1',
      worktreeId: 'wt-1',
      ptyIds: [
        'pty-index',
        'pty-row',
        'pty-layout',
        'remote:env-1@@terminal-1',
        'ssh:ssh-1@@relay-pty',
        'pty-deferred',
        'pty-pending'
      ],
      localOrSshPtyIds: [
        'pty-index',
        'pty-row',
        'pty-layout',
        'ssh:ssh-1@@relay-pty',
        'pty-deferred',
        'pty-pending'
      ],
      runtimeTerminals: [
        {
          ptyId: 'remote:env-1@@terminal-1',
          environmentId: 'env-1',
          handle: 'terminal-1'
        }
      ],
      cleanupOnlyPtyIds: [],
      sharedPtyIds: [],
      unroutablePtyIds: []
    })
    expect(isTerminalTabPresent(state, 'tab-1')).toBe(true)
  })

  it('does not retire a PTY still referenced by another live surface', () => {
    const shared = 'pty-in-transfer'
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'wt-1', shared), makeTab('tab-2', 'wt-1', null)]
      },
      ptyIdsByTabId: { 'tab-1': [shared], 'tab-2': [shared] },
      terminalLayoutsByTabId: {
        'tab-2': {
          root: null,
          activeLeafId: null,
          expandedLeafId: null,
          ptyIdsByLeafId: { leaf2: shared }
        }
      }
    })

    const plan = buildTerminalTabRetirementPlan(state, 'tab-1')
    expect(plan.sharedPtyIds).toEqual([shared])
    expect(plan.localOrSshPtyIds).toEqual([])
    expect(plan.runtimeTerminals).toEqual([])
  })

  it('protects a scoped runtime terminal referenced through its legacy alias', () => {
    const scoped = 'remote:env-1@@terminal-1'
    const legacy = 'remote:terminal-1'
    const state = makeState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreesByRepo: {
        repo: [
          { id: 'wt-1', repoId: 'repo' },
          { id: 'wt-2', repoId: 'repo' }
        ]
      },
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'wt-1', legacy)],
        'wt-2': [makeTab('tab-2', 'wt-2', scoped)]
      },
      ptyIdsByTabId: { 'tab-1': [legacy], 'tab-2': [scoped] }
    })

    const plan = buildTerminalTabRetirementPlan(state, 'tab-1')
    expect(plan.sharedPtyIds).toEqual([legacy])
    expect(plan.runtimeTerminals).toEqual([])
  })

  it('deduplicates legacy and scoped aliases owned by the closing tab', () => {
    const state = makeState({
      settings: { activeRuntimeEnvironmentId: 'env-1' },
      worktreesByRepo: { repo: [{ id: 'wt-1', repoId: 'repo' }] },
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'wt-1', 'remote:terminal-1')]
      },
      ptyIdsByTabId: {
        'tab-1': ['remote:terminal-1', 'remote:env-1@@terminal-1']
      }
    })

    expect(buildTerminalTabRetirementPlan(state, 'tab-1').runtimeTerminals).toEqual([
      {
        ptyId: 'remote:terminal-1',
        environmentId: null,
        handle: 'terminal-1'
      }
    ])
  })

  it('ignores stale ownership maps and never routes malformed remote ids locally', () => {
    const malformedRemote = 'remote:'
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'wt-1', malformedRemote)]
      },
      ptyIdsByTabId: {
        'tab-1': [malformedRemote, 'pty-live'],
        'stale-tab': ['pty-live']
      }
    })

    const plan = buildTerminalTabRetirementPlan(state, 'tab-1')
    expect(plan.unroutablePtyIds).toEqual([malformedRemote])
    expect(plan.localOrSshPtyIds).toEqual(['pty-live'])
    expect(plan.sharedPtyIds).toEqual([])
  })

  it('never kills a HUB-native PTY when duplicate worktree ownership is ambiguous', () => {
    const state = makeState({
      worktreesByRepo: {
        repo: [
          { id: 'wt-1', repoId: 'repo', hostId: 'ssh:private', runtimeOwnerEnvironmentId: 'hub-a' },
          { id: 'wt-1', repoId: 'repo', hostId: 'ssh:private', runtimeOwnerEnvironmentId: 'hub-b' }
        ]
      },
      tabsByWorktree: {
        'wt-1': [makeTab('tab-1', 'wt-1', 'ssh:private@@pty-1')]
      }
    })

    const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

    expect(plan.localOrSshPtyIds).toEqual([])
    expect(plan.runtimeTerminals).toEqual([])
    expect(plan.unroutablePtyIds).toEqual(['ssh:private@@pty-1'])
  })

  it('never falls an unknown stale worktree through to local PTY teardown', () => {
    const state = makeState({
      worktreesByRepo: {},
      tabsByWorktree: {
        'stale-worktree': [makeTab('tab-1', 'stale-worktree', 'ssh:private@@pty-1')]
      }
    })

    const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

    expect(plan.localOrSshPtyIds).toEqual([])
    expect(plan.unroutablePtyIds).toEqual(['ssh:private@@pty-1'])
  })

  // STA-2639: these surfaces publish no runtime owner, so teardown read them as unresolved and
  // dropped their ordinary local PTYs instead of killing them.
  describe('host-agnostic terminal surfaces are killed, not dropped', () => {
    const localSurfaces: [string, string][] = [
      ['floating terminal', FLOATING_TERMINAL_WORKTREE_ID],
      ['ephemeral setup terminal', brandEphemeralSetupTerminalWorktreeId('panel-1')],
      ['folder workspace', folderWorkspaceKey('fw-1')]
    ]

    for (const [label, worktreeId] of localSurfaces) {
      it(`kills a local ${label} PTY while a runtime is focused`, () => {
        // Why: a focused runtime must not make a local surface read as runtime-owned — that focus
        // also flips as the runtime catalog hydrates, so teardown cannot trust it.
        const state = makeState({
          settings: { activeRuntimeEnvironmentId: 'hub-a' },
          runtimeEnvironments: [{ id: 'hub-a' }],
          folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'pg-1', connectionId: null }],
          projectGroups: [{ id: 'pg-1', connectionId: null, executionHostId: null }],
          tabsByWorktree: { [worktreeId]: [makeTab('tab-1', worktreeId, 'pty-1')] }
        } as unknown as Partial<RetirementState>)

        const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

        expect(plan.localOrSshPtyIds).toEqual(['pty-1'])
        expect(plan.unroutablePtyIds).toEqual([])
      })
    }

    it('closes a runtime-hosted floating terminal over RPC instead of killing it locally', () => {
      const state = makeState({
        settings: { activeRuntimeEnvironmentId: 'hub-a' },
        runtimeEnvironments: [{ id: 'hub-a' }],
        tabsByWorktree: {
          [FLOATING_TERMINAL_WORKTREE_ID]: [
            makeTab('tab-1', FLOATING_TERMINAL_WORKTREE_ID, 'remote:hub-a@@handle-1')
          ]
        }
      } as unknown as Partial<RetirementState>)

      const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

      expect(plan.localOrSshPtyIds).toEqual([])
      expect(plan.runtimeTerminals).toEqual([
        { ptyId: 'remote:hub-a@@handle-1', environmentId: 'hub-a', handle: 'handle-1' }
      ])
    })

    it('never kills a HUB-owned folder workspace PTY', () => {
      const state = makeState({
        folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'pg-1', connectionId: null }],
        projectGroups: [{ id: 'pg-1', connectionId: null, executionHostId: 'runtime:hub-a' }],
        tabsByWorktree: {
          [folderWorkspaceKey('fw-1')]: [makeTab('tab-1', folderWorkspaceKey('fw-1'), 'pty-hub')]
        }
      } as unknown as Partial<RetirementState>)

      const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

      expect(plan.localOrSshPtyIds).toEqual([])
      expect(plan.unroutablePtyIds).toEqual(['pty-hub'])
    })

    it('never kills a HUB wake hint on a worktree owned only by the focused runtime', () => {
      // Why: an ownerless mixed-version row legitimately spawns on the focused HUB (see
      // pty-connection "uses the focused runtime only for ownerless mixed-version publications"),
      // and its wake hint is `ssh:`-shaped, not `remote:` — killing it would hit the wrong host.
      const state = makeState({
        repos: [{ id: 'repo1', connectionId: null }],
        worktreesByRepo: { repo1: [{ id: 'wt-legacy', repoId: 'repo1' }] },
        settings: { activeRuntimeEnvironmentId: 'legacy-hub' },
        runtimeEnvironments: [{ id: 'legacy-hub' }],
        tabsByWorktree: {
          'wt-legacy': [makeTab('tab-1', 'wt-legacy', 'ssh:hub-private@@pty-2')]
        }
      } as unknown as Partial<RetirementState>)

      const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

      expect(plan.localOrSshPtyIds).toEqual([])
      expect(plan.unroutablePtyIds).toEqual(['ssh:hub-private@@pty-2'])
    })

    it('never kills a PTY whose owning tab row is already gone', () => {
      // Why: a vanished row is the ambiguity #9994 guards — nothing proves which host holds the PTY.
      const state = makeState({ ptyIdsByTabId: { 'tab-1': ['pty-ghost'] } })

      const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

      expect(plan.localOrSshPtyIds).toEqual([])
      expect(plan.unroutablePtyIds).toEqual(['pty-ghost'])
    })

    it('never kills an unknown worktree PTY when every owner catalog is absent', () => {
      // Why: spawn falls back to the focused runtime (local when none) while catalogs load, but
      // teardown taking that fail-open would kill an unidentified PTY on a guess.
      const state = makeState({
        worktreesByRepo: undefined,
        detectedWorktreesByRepo: undefined,
        repos: undefined,
        tabsByWorktree: { 'wt-unknown': [makeTab('tab-1', 'wt-unknown', 'pty-1')] }
      } as unknown as Partial<RetirementState>)

      const plan = buildTerminalTabRetirementPlan(state, 'tab-1')

      expect(plan.localOrSshPtyIds).toEqual([])
      expect(plan.unroutablePtyIds).toEqual(['pty-1'])
    })
  })

  it('deduplicates batch-owned PTYs while protecting owners outside the close set', () => {
    const state = makeState({
      tabsByWorktree: {
        'wt-1': [
          makeTab('tab-1', 'wt-1', 'pty-batch'),
          makeTab('tab-2', 'wt-1', 'pty-batch'),
          makeTab('later-tab', 'wt-1', 'pty-external')
        ]
      },
      ptyIdsByTabId: {
        'tab-1': ['pty-batch', 'pty-external'],
        'tab-2': ['pty-batch'],
        'later-tab': ['pty-external']
      }
    })

    const plans = buildTerminalTabRetirementPlans(state, ['tab-1', 'tab-2'])

    expect(plans.get('tab-1')).toMatchObject({
      localOrSshPtyIds: ['pty-batch'],
      sharedPtyIds: ['pty-external']
    })
    expect(plans.get('tab-2')).toMatchObject({
      localOrSshPtyIds: [],
      cleanupOnlyPtyIds: ['pty-batch'],
      sharedPtyIds: []
    })
  })

  it('indexes live owners once for a 100-tab batch', () => {
    const tabs = Array.from({ length: 100 }, (_, index) =>
      makeTab(`tab-${index}`, 'wt-1', `pty-${index}`)
    )
    let terminalStoreScans = 0
    let unifiedStoreScans = 0
    const state = makeState({
      tabsByWorktree: new Proxy(
        { 'wt-1': tabs },
        {
          ownKeys(target) {
            terminalStoreScans += 1
            return Reflect.ownKeys(target)
          }
        }
      ),
      unifiedTabsByWorktree: new Proxy(
        {},
        {
          ownKeys(target) {
            unifiedStoreScans += 1
            return Reflect.ownKeys(target)
          }
        }
      ),
      ptyIdsByTabId: Object.fromEntries(tabs.map((tab, index) => [tab.id, [`pty-${index}`]]))
    })

    const plans = buildTerminalTabRetirementPlans(
      state,
      tabs.map((tab) => tab.id)
    )

    expect(plans).toHaveLength(100)
    expect(terminalStoreScans).toBe(1)
    expect(unifiedStoreScans).toBe(1)
  })
})

describe('sleeping agent retirement', () => {
  it('removes key- and metadata-owned records while preserving siblings by reference', () => {
    const sibling = makeSleepingRecord('tab-2:leaf-2', 'tab-2')
    const records = {
      'tab-1:leaf-1': makeSleepingRecord('tab-1:leaf-1'),
      'legacy-pane-key': makeSleepingRecord('legacy-pane-key', 'tab-1'),
      'tab-2:leaf-2': sibling
    }

    const next = removeSleepingAgentSessionsForTab(records, 'tab-1')
    expect(next).toEqual({ 'tab-2:leaf-2': sibling })
    expect(next['tab-2:leaf-2']).toBe(sibling)
    expect(removeSleepingAgentSessionsForTab(next, 'missing-tab')).toBe(next)
  })
})
