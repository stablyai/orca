import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { makeOpenFile } from '../../store/slices/store-session-test-harness'
import { makeRetainedDoneEntry, makeTab, makeWorktree } from './ActivityPrototypePage-test-fixtures'
import type { AgentPaneThread } from './activity-thread-types'

const feedback = vi.hoisted(() => {
  type Options = {
    action: { label: string; onClick: () => void }
    onDismiss: () => void
    onAutoClose: () => void
  }
  let held: Options | null = null
  return {
    toast: (_message: string, options: Options): void => {
      held = options
    },
    take: (): Options => {
      const options = held
      held = null
      if (!options) {
        throw new Error('Expected the completed-activity Undo feedback')
      }
      return options
    },
    release: (): void => {
      held = null
    }
  }
})

vi.mock('sonner', () => ({ toast: feedback.toast }))

import {
  clearCompletedActivity,
  flushPendingClearCompletedEvictions
} from './activity-clear-completed'

const initialState = useAppStore.getState()
const fileId = 'discarded-activity-document'
const dropPersistedBatch = vi.fn()

function clearWithOpenDraft(clear: boolean = true) {
  const tab = makeTab()
  const retained = makeRetainedDoneEntry(tab)
  const paneKey = retained.entry.paneKey
  const thread: AgentPaneThread = {
    paneKey,
    tab,
    worktree: makeWorktree(),
    repo: null,
    currentAgentState: null,
    currentAgentEntry: null,
    latestEvent: null,
    latestTimestamp: retained.entry.updatedAt,
    agentType: 'claude',
    unread: false,
    paneTitle: 'Completed agent',
    responsePreview: '',
    events: []
  }
  useAppStore.setState({
    openFiles: [makeOpenFile({ id: fileId, worktreeId: 'wt-1' })],
    retainedAgentsByPaneKey: { [paneKey]: retained },
    agentStatusByPaneKey: { [paneKey]: retained.entry }
  })
  useAppStore.getState().setEditorDraft(fileId, 'Discarded editor draft\n')
  const state = useAppStore.getState()
  const retired = {
    state: new WeakRef(state),
    drafts: new WeakRef(state.editorDrafts),
    undoSnapshot: new WeakRef(retained),
    paneKey,
    cutoff: retained.entry.updatedAt
  }
  if (clear) {
    expect(clearCompletedActivity([thread])).toBe(true)
  }
  useAppStore.getState().closeFile(fileId)
  return retired
}

async function collectRetiredState(): Promise<void> {
  if (typeof globalThis.gc !== 'function') {
    throw new Error('Run with the repository Vitest --expose-gc config')
  }
  for (let round = 0; round < 3; round += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve))
    globalThis.gc()
  }
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
  useAppStore.setState(initialState, true)
  vi.stubGlobal('window', { api: { agentStatus: { dropPersistedBatch } } })
})

afterEach(() => {
  feedback.release()
  flushPendingClearCompletedEvictions()
  useAppStore.setState(initialState, true)
  vi.clearAllMocks()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('completed Activity state lifetime', () => {
  it('releases closed editor state while the eviction timer still owns the Undo plan', async () => {
    const retired = clearWithOpenDraft()
    feedback.release()
    expect(useAppStore.getState().openFiles).toHaveLength(0)
    expect(useAppStore.getState().editorDrafts[fileId]).toBeUndefined()
    expect(useAppStore.getState().activityClearedAtByPaneKey[retired.paneKey]).toBe(retired.cutoff)
    expect(dropPersistedBatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(1)

    await collectRetiredState()

    expect(retired.state.deref()).toBeUndefined()
    expect(retired.drafts.deref()).toBeUndefined()
    expect(retired.undoSnapshot.deref()?.entry.lastAssistantMessage).toBe(
      'Retained response preview'
    )
    flushPendingClearCompletedEvictions()
    expect(dropPersistedBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases closed editor state while an invoked Undo callback still owns its snapshot', async () => {
    const retired = clearWithOpenDraft()
    const options = feedback.take()
    options.action.onClick()
    expect(useAppStore.getState().activityClearedAtByPaneKey[retired.paneKey]).toBeUndefined()
    expect(useAppStore.getState().retentionSuppressedPaneKeys[retired.paneKey]).toBeUndefined()
    expect(vi.getTimerCount()).toBe(0)

    await collectRetiredState()

    expect(retired.state.deref()).toBeUndefined()
    expect(retired.drafts.deref()).toBeUndefined()
    expect(retired.undoSnapshot.deref()?.entry.lastAssistantMessage).toBe(
      'Retained response preview'
    )
    options.onAutoClose()
    expect(dropPersistedBatch).not.toHaveBeenCalled()
  })

  it('releases obsolete state when the pending eviction is flushed', async () => {
    const retired = clearWithOpenDraft()
    feedback.release()
    flushPendingClearCompletedEvictions()
    await collectRetiredState()

    expect(retired.state.deref()).toBeUndefined()
    expect(retired.drafts.deref()).toBeUndefined()
    expect(retired.undoSnapshot.deref()).toBeUndefined()
    expect(dropPersistedBatch).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases closed editor state without a completed-activity clear', async () => {
    const retired = clearWithOpenDraft(false)
    await collectRetiredState()

    expect(retired.state.deref()).toBeUndefined()
    expect(retired.drafts.deref()).toBeUndefined()
    expect(retired.undoSnapshot.deref()).toBe(
      useAppStore.getState().retainedAgentsByPaneKey[retired.paneKey]
    )
    expect(dropPersistedBatch).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})
