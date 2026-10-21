// @vitest-environment happy-dom

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SourceControlToastTestOptions } from './source-control-toast-test-options'

const { toastError, toastDismiss } = vi.hoisted(() => ({
  toastError: vi.fn<(title: string, options?: SourceControlToastTestOptions) => void>(),
  toastDismiss: vi.fn<(id: string) => void>()
}))
vi.mock('sonner', () => ({ toast: { error: toastError, dismiss: toastDismiss } }))

const { storeState } = vi.hoisted(() => ({ storeState: { activeWorktreeId: 'wt-1' } }))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => undefined, { getState: () => storeState })
}))

import {
  dismissSourceControlEntryFailureToast,
  showSourceControlEntryFailureToast
} from './source-control-entry-failure-toast'

type FailureToastInput = Parameters<typeof showSourceControlEntryFailureToast>[0]

function lastToast(): { title: string; options: SourceControlToastTestOptions } {
  const [title = '', options = {}] = toastError.mock.lastCall ?? []
  return { title, options }
}

function show(overrides: Partial<FailureToastInput> = {}): void {
  showSourceControlEntryFailureToast({
    operation: 'stage',
    filePath: 'src/app.ts',
    error: new Error('index.lock exists'),
    worktreeId: 'wt-1',
    worktreeName: 'feature-a',
    ...overrides
  })
}

function clickRetry(): { preventDefault: ReturnType<typeof vi.fn> } {
  const event = { preventDefault: vi.fn() }
  lastToast().options.action?.onClick(event)
  return event
}

describe('showSourceControlEntryFailureToast', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    storeState.activeWorktreeId = 'wt-1'
  })

  it('names the failed operation and the file', () => {
    show()
    expect(lastToast().title).toBe('Failed to stage “src/app.ts”')
    show({ operation: 'unstage' })
    expect(lastToast().title).toBe('Failed to unstage “src/app.ts”')
    show({ operation: 'discard' })
    expect(lastToast().title).toBe('Failed to discard “src/app.ts”')
  })

  it('says "delete" for an entry whose discard removes the file rather than restoring it', () => {
    // Why: untracked and added paths have no HEAD version, so the row button and the confirmation
    // dialog both say "delete" — the failure must not contradict the verb the user pressed.
    show({ operation: 'discard', deletesFile: true })
    expect(lastToast().title).toBe('Failed to delete “src/app.ts”')
  })

  it('keeps the underlying detail but drops the Electron IPC wrapper', () => {
    show({
      error: new Error("Error invoking remote method 'git:stage': Error: index.lock exists")
    })
    expect(lastToast().options.description).toBe('index.lock exists')
  })

  it('uses one stable slot for entry failures', () => {
    show()
    expect(lastToast().options.id).toBe('source-control-entry-mutation')
    storeState.activeWorktreeId = 'wt-2'
    show({ worktreeId: 'wt-2', worktreeName: 'feature-b' })
    expect(lastToast().options.id).toBe('source-control-entry-mutation')
  })

  it('still reports a failure belonging to a worktree the user has left, naming it', () => {
    // Why: suppressing the ACTION on a worktree mismatch is right; suppressing the REPORT would
    // reintroduce exactly the silent failure this module exists to remove.
    storeState.activeWorktreeId = 'wt-2'
    show({ worktreeId: 'wt-1', worktreeName: 'feature-a', onRetry: vi.fn() })

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(lastToast().title).toBe('Failed to stage “src/app.ts” in feature-a')
    expect(lastToast().options.action).toBeUndefined()
    expect(lastToast().options.duration).toBeUndefined()
  })

  it('offers Retry, and a readable lifetime, only in the worktree that failed', () => {
    const onRetry = vi.fn()
    show({ onRetry })
    expect(lastToast().options.action?.label).toBe('Retry')
    expect(lastToast().options.duration).toBe(10000)
    clickRetry()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('keeps sonner from auto-dismissing the slot the retry is about to re-raise into', () => {
    // Why: sonner's post-click removal is scheduled by id, so it would swallow a re-failure raised
    // within ~200ms; preventDefault hands the slot's lifetime to the retry itself.
    const onRetry = vi.fn()
    show({ onRetry })

    expect(clickRetry().preventDefault).toHaveBeenCalledTimes(1)
    expect(toastDismiss).not.toHaveBeenCalled()
  })

  it('retires a Retry action that became stale after a worktree switch', () => {
    const onRetry = vi.fn()
    show({ onRetry })
    storeState.activeWorktreeId = 'wt-2'

    clickRetry()

    expect(onRetry).not.toHaveBeenCalled()
    expect(toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })

  it('clears the shared slot when an attempt finally lands', () => {
    show()
    dismissSourceControlEntryFailureToast('wt-1')
    expect(toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })

  it('leaves a failure another worktree raised into the slot alone', () => {
    // Why: a retry still in flight in the worktree the user left must not erase the failure the
    // worktree they switched to has since raised into the shared slot.
    show({ worktreeId: 'wt-1' })
    storeState.activeWorktreeId = 'wt-2'
    show({ worktreeId: 'wt-2', worktreeName: 'feature-b' })

    dismissSourceControlEntryFailureToast('wt-1')
    expect(toastDismiss).not.toHaveBeenCalled()

    dismissSourceControlEntryFailureToast('wt-2')
    expect(toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })

  it('omits the description when the failure carried no readable message', () => {
    show({ error: 'not an Error' })
    expect(lastToast().options.description).toBeUndefined()
  })
})
