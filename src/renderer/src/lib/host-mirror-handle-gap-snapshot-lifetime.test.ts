import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore, type AppState } from '@/store'
import { makeTab } from '@/store/slices/store-test-helpers'
import {
  clearRuntimeEnvironmentConnectionGenerationsForTests,
  setRuntimeEnvironmentConnectionGenerationForTests
} from '@/store/slices/runtime-status'
import {
  HOST_MIRROR_HANDLE_GAP_DEADLINE_MS,
  countHostMirrorHandleGapVerdictsForTests,
  countParkedHostMirrorHandleGapPanesForTests,
  hasHostMirrorHandleWaitExpired,
  parkUntilHostMirrorHandleLands,
  resetHostMirrorHandleGapWaitsForTests
} from './host-mirror-handle-gap-wait'

const ENVIRONMENT_ID = 'env-snapshot-lifetime'
const WORKTREE_ID = 'repo-1::/workspace/snapshot-lifetime'
const TAB_ID = 'tab-snapshot-lifetime'
const LEAF_ID = '11111111-1111-4111-8111-111111111111'
const PTY_ID = `remote:${ENVIRONMENT_ID}@@term_snapshot`
const FILE_ID = 'discarded-document'
const initialAppStoreState = useAppStore.getState()

async function collectRetiredSnapshots(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

function parkAndRemoveDraft(source: 'initial' | 'terminal-write', replay: () => void) {
  useAppStore.getState().setEditorDraft(FILE_ID, 'discarded document text\n')
  parkUntilHostMirrorHandleLands(ENVIRONMENT_ID, WORKTREE_ID, TAB_ID, replay)
  if (source === 'terminal-write') {
    useAppStore.setState({
      ptyIdsByTabId: { ...useAppStore.getState().ptyIdsByTabId, 'another-tab': ['another-pty'] }
    })
  }
  const state = useAppStore.getState()
  const retired = {
    snapshot: new WeakRef<AppState>(state),
    drafts: new WeakRef(state.editorDrafts)
  }
  state.clearEditorDraft(FILE_ID)
  return retired
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  resetHostMirrorHandleGapWaitsForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  useAppStore.setState(initialAppStoreState, true)
  setRuntimeEnvironmentConnectionGenerationForTests(ENVIRONMENT_ID, 1)
  useAppStore.setState({
    ptyIdsByTabId: {},
    tabsByWorktree: {
      [WORKTREE_ID]: [makeTab({ id: TAB_ID, worktreeId: WORKTREE_ID })]
    },
    terminalLayoutsByTabId: {
      [TAB_ID]: {
        root: { type: 'leaf', leafId: LEAF_ID },
        activeLeafId: LEAF_ID,
        expandedLeafId: null,
        ptyIdsByLeafId: { [LEAF_ID]: PTY_ID }
      }
    }
  })
})

afterEach(() => {
  resetHostMirrorHandleGapWaitsForTests()
  clearRuntimeEnvironmentConnectionGenerationsForTests()
  useAppStore.setState(initialAppStoreState, true)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('host-mirror handle-gap snapshot lifetime', () => {
  it.each([
    { source: 'initial', lifetime: 'pending' },
    { source: 'terminal-write', lifetime: 'pending' },
    { source: 'initial', lifetime: 'verdict' },
    { source: 'terminal-write', lifetime: 'verdict' }
  ] as const)('releases the $source snapshot during $lifetime observation', async (scenario) => {
    const replay = vi.fn<() => void>()
    const retired = parkAndRemoveDraft(scenario.source, replay)
    const ptyIds = useAppStore.getState().ptyIdsByTabId
    const tabs = useAppStore.getState().tabsByWorktree
    if (scenario.lifetime === 'verdict') {
      vi.advanceTimersByTime(HOST_MIRROR_HANDLE_GAP_DEADLINE_MS)
      expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
      expect(countHostMirrorHandleGapVerdictsForTests()).toBe(1)
      expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, TAB_ID)).toBe(true)
      expect(replay).toHaveBeenCalledTimes(1)
    } else {
      expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(1)
      expect(countHostMirrorHandleGapVerdictsForTests()).toBe(0)
      expect(replay).not.toHaveBeenCalled()
    }

    expect(useAppStore.getState().editorDrafts[FILE_ID]).toBeUndefined()
    expect(useAppStore.getState().ptyIdsByTabId).toBe(ptyIds)
    expect(useAppStore.getState().tabsByWorktree).toBe(tabs)
    replay.mockClear()
    await collectRetiredSnapshots()
    expect(retired.snapshot.deref()).toBeUndefined()
    expect(retired.drafts.deref()).toBeUndefined()

    useAppStore.setState({ ptyIdsByTabId: { ...ptyIds, [TAB_ID]: [PTY_ID] } })
    expect(countParkedHostMirrorHandleGapPanesForTests()).toBe(0)
    expect(countHostMirrorHandleGapVerdictsForTests()).toBe(0)
    expect(hasHostMirrorHandleWaitExpired(ENVIRONMENT_ID, TAB_ID)).toBe(false)
    expect(replay).toHaveBeenCalledTimes(scenario.lifetime === 'pending' ? 1 : 0)
    expect(vi.getTimerCount()).toBe(0)
  })
})
