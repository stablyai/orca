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

  it('still reports a failure belonging to a worktree the user has left, naming it', () => {
    // Suppress stale recovery actions after switches, but still report the original workspace's failure.
    storeState.activeWorktreeId = 'wt-2'
    show({ worktreeId: 'wt-1', worktreeName: 'feature-a', onRetry: vi.fn() })

    expect(toastError).toHaveBeenCalledTimes(1)
    expect(lastToast().title).toBe('Failed to stage “src/app.ts” in feature-a')
    expect(lastToast().options.action).toBeUndefined()
    expect(lastToast().options.duration).toBeUndefined()
  })

  it('retires a Retry action that became stale after a worktree switch', () => {
    const onRetry = vi.fn()
    show({ onRetry })
    storeState.activeWorktreeId = 'wt-2'

    clickRetry()

    expect(onRetry).not.toHaveBeenCalled()
    expect(toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })

  it('leaves a failure another worktree raised into the slot alone', () => {
    // A slow old-workspace retry must not dismiss a newer workspace's failure in the shared slot.
    show({ worktreeId: 'wt-1' })
    storeState.activeWorktreeId = 'wt-2'
    show({ worktreeId: 'wt-2', worktreeName: 'feature-b' })

    dismissSourceControlEntryFailureToast('wt-1')
    expect(toastDismiss).not.toHaveBeenCalled()

    dismissSourceControlEntryFailureToast('wt-2')
    expect(toastDismiss).toHaveBeenCalledWith('source-control-entry-mutation')
  })
})
