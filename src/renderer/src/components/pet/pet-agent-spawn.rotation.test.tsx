// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'

import type { AppState } from '../../store/types'
import { useAppStore } from '../../store'
import { setPetBoundSession, getPetBoundSession } from './pet-bound-session'
import {
  buildPetOmpAgentArgs,
  PET_OMP_MODEL,
  usePetAgentSpawn
} from './pet-agent-spawn'
import type { createTestStore } from '../../store/slices/store-test-helpers'
import { makeTab, makeWorktree, seedStore } from '../../store/slices/store-test-helpers'
import { isAgentBusyForRoam } from '../../../../shared/pet-roam'
import { petBubbleWinnerKey, selectPetBubbleWinner } from '../../../../shared/pet-bubble-text'
import type { LaunchAgentInNewTabResult } from '../../lib/launch-agent-in-new-tab'
import type { AgentStatusEntry } from '../../../../shared/agent-status-types'
import { AGENT_STATUS_STALE_AFTER_MS } from '../../../../shared/agent-status-types'

type PetSpawnStore = ReturnType<typeof createTestStore>

const WT = 'repo::/home/nixos/meshina'
const PREV_TAB = 'tab-prev'
const NEXT_TAB = 'tab-next'
const PREV_LEAF = '11111111-1111-4111-8111-111111111111'
const PREV_PANE = `${PREV_TAB}:${PREV_LEAF}`

// Why: rotation must drop a stale "busy" row from the previous bound tab so the
// pet's roam resumes and the bubble winner key can change. The previous bound
// tab is intentionally kept OPEN (closing it would route through closeTab and
// also drop the row via dropAgentStatusByTabPrefix) to model the real rotation
// shape — the bound-assistant commit (e6006c198) created a new tab without
// tearing down the old one, and the rotation commit (0a17cab37) then started
// spinning up a fresh session on a 1-3h cadence while leaving the previous
// session's PTY live. The omp hook stream keeps the previous paneKey entry
// fresh, so isAgentBusyForRoam stays true and selectPetBubbleWinner keeps
// returning the same winner — exactly the freeze the operator reported.

const launchAgentInNewTab = vi.fn((): LaunchAgentInNewTabResult | null => {
  return { tabId: NEXT_TAB } as unknown as LaunchAgentInNewTabResult
})

vi.mock('@/lib/launch-agent-in-new-tab', () => ({
  launchAgentInNewTab: () => launchAgentInNewTab()
}))

vi.mock('sonner', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn(), warning: vi.fn(), message: vi.fn() }
}))

function seedWorktreeWithTabs(store: PetSpawnStore): void {
  seedStore(store, {
    activeWorktreeId: WT,
    worktreesByRepo: {
      repo: [makeWorktree({ id: WT, repoId: 'repo', path: '/home/nixos/meshina' })]
    },
    tabsByWorktree: {
      [WT]: [
        makeTab({ id: PREV_TAB, worktreeId: WT }),
        makeTab({ id: NEXT_TAB, worktreeId: WT })
      ]
    },
    settings: { activeRuntimeEnvironmentId: null } as unknown as AppState['settings']
  } as Partial<AppState>)
}

function makePrevWaitingEntry(): AgentStatusEntry {
  return {
    paneKey: PREV_PANE,
    tabId: PREV_TAB,
    worktreeId: WT,
    prompt: 'previous turn prompt',
    state: 'waiting',
    updatedAt: Date.now(),
    stateStartedAt: Date.now(),
    stateHistory: [],
    toolName: 'bash',
    agentType: 'omp'
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  // Why: the spawn reads the persisted epoch from localStorage; clear it so
  // resolveSpawnFreshness treats every spawn as a "fresh" rotation candidate
  // (the rotation path) rather than a no-op "continue" resume.
  globalThis.localStorage?.clear()
  launchAgentInNewTab.mockImplementation((): LaunchAgentInNewTabResult | null => {
    return { tabId: NEXT_TAB } as unknown as LaunchAgentInNewTabResult
  })
})

afterEach(() => {
  setPetBoundSession(null)
  useAppStore.setState(useAppStore.getInitialState(), true)
})

describe('usePetAgentSpawn (rotation leak regression)', () => {
  it('keeps the model + flag invariants that fixed bugs previously flagged here', () => {
    // Why: pinned regression — flaky approval posture or an assistant that
    // answers from a different model than speak-back are user-visible bugs
    // this module has shipped before.
    expect(buildPetOmpAgentArgs(WT)).toContain('--approval-mode always-ask')
    expect(buildPetOmpAgentArgs(WT)).toContain(`--model ${PET_OMP_MODEL}`)
  })

  it('drops the previous bound tab\'s status entry when a fresh spawn rebinds the pet', () => {
    const store = useAppStore as unknown as PetSpawnStore
    seedWorktreeWithTabs(store)

    // Previous bound tab carries a fresh `waiting` entry the omp session is
    // still refreshing — the exact leak shape the operator reported. Without
    // the fix, this entry pins the bubble winner and keeps roam paused.
    setPetBoundSession({ tabId: PREV_TAB, worktreeId: WT })
    store.getState().setAgentStatus(PREV_PANE, makePrevWaitingEntry())

    expect(
      isAgentBusyForRoam(
        [store.getState().agentStatusByPaneKey[PREV_PANE]!],
        Date.now(),
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBe(true)
    expect(
      selectPetBubbleWinner(
        [store.getState().agentStatusByPaneKey[PREV_PANE]!].filter(
          (entry): entry is AgentStatusEntry => Boolean(entry)
        ),
        Date.now(),
        AGENT_STATUS_STALE_AFTER_MS
      )?.paneKey
    ).toBe(PREV_PANE)

    const { result } = renderHook(() => usePetAgentSpawn())
    expect(result.current.canSpawn).toBe(true)

    act(() => {
      result.current.spawnOmpAgent()
    })

    // rebinding happened
    expect(getPetBoundSession()?.tabId).toBe(NEXT_TAB)
    // previous bound tab's paneKey entry is cleared so its stale `waiting`
    // can't keep the pet frozen on the rotation
    expect(store.getState().agentStatusByPaneKey[PREV_PANE]).toBeUndefined()
    // roam is now free (nothing fresh in the live map)
    expect(
      isAgentBusyForRoam(
        Object.values(store.getState().agentStatusByPaneKey),
        Date.now(),
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBe(false)
    // and the bubble winner key returns to empty so a brand-new `running` row
    // can mutate it on the next event
    expect(
      selectPetBubbleWinner(
        Object.values(store.getState().agentStatusByPaneKey),
        Date.now(),
        AGENT_STATUS_STALE_AFTER_MS
      )
    ).toBeNull()
    expect(petBubbleWinnerKey(null)).toBe('')
  })

  it('survives a rotation when there is no previous bound tab (first spawn)', () => {
    const store = useAppStore as unknown as PetSpawnStore
    seedWorktreeWithTabs(store)

    // no setPetBoundSession — first spawn
    const { result } = renderHook(() => usePetAgentSpawn())

    act(() => {
      result.current.spawnOmpAgent()
    })

    expect(getPetBoundSession()?.tabId).toBe(NEXT_TAB)
    // no-op: nothing was bound to begin with, so the (empty) sweep does not
    // throw and the spawn still binds
    expect(Object.keys(store.getState().agentStatusByPaneKey)).toHaveLength(0)
  })

  it('swallows a benign error (does not crash, no bound change) when the spawn returns no tabId', () => {
    const store = useAppStore as unknown as PetSpawnStore
    seedWorktreeWithTabs(store)
    setPetBoundSession({ tabId: PREV_TAB, worktreeId: WT })
    store.getState().setAgentStatus(PREV_PANE, {
      state: 'waiting',
      prompt: 'previous turn prompt',
      agentType: 'omp'
    })
    // Why: the helper returns null when no startup plan can be built
    // (launch-agent-in-new-tab.ts handles this internally). The rotation
    // sweep must not break that path; the previous bound tab's row stays in
    // place because no new binding happened.
    launchAgentInNewTab.mockReturnValueOnce(null as unknown as LaunchAgentInNewTabResult)

    const { result } = renderHook(() => usePetAgentSpawn())
    act(() => {
      result.current.spawnOmpAgent()
    })

    // binding untouched, status untouched
    expect(getPetBoundSession()?.tabId).toBe(PREV_TAB)
    expect(store.getState().agentStatusByPaneKey[PREV_PANE]).toBeDefined()
  })
})
