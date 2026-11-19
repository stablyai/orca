// @vitest-environment happy-dom

import { act, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AutoRenameFailedDialog } from './AutoRenameFailedDialog'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import type { ExecutionHostId } from '../../../../../../shared/execution-host/execution-host'
import type {
  BranchAutoRenameAttemptEvent,
  BranchAutoRenameRetryResult
} from '../../../../../../shared/worktree/branch-auto-rename-attempt'

vi.mock('sonner', () => ({ toast: { error: vi.fn() } }))

const getBranchRenameFailureOutput =
  vi.fn<(args: { worktreeId: string }) => Promise<string | null>>()
const writeClipboardText = vi.fn<(text: string) => Promise<void>>()
const updateWorktreeMeta = vi.fn<AppState['updateWorktreeMeta']>()
const updateMeta = vi.fn<() => Promise<void>>()
const getBranchAutoRenameRetryAvailability =
  vi.fn<() => Promise<{ available: boolean; runningAttemptId: number | null }>>()
const retryBranchAutoRename = vi.fn<() => Promise<BranchAutoRenameRetryResult>>()
let emitAttempt: (event: BranchAutoRenameAttemptEvent) => void = () => {}
const onBranchAutoRenameAttempt = vi.fn(
  (listener: (event: BranchAutoRenameAttemptEvent) => void) => {
    emitAttempt = listener
    return () => {}
  }
)

// Mirrors the card surface: the dialog stays mounted while open, even after the error clears.
function WorkspaceFailure() {
  const worktree = useAppStore((s) => s.worktreesByRepo.repo1?.[0])
  const [open, setOpen] = useState(true)
  const error = worktree?.firstAgentMessageRenameError
  return worktree && (open || error) ? (
    <>
      {error ? <span>rename failed</span> : null}
      <AutoRenameFailedDialog
        open={open}
        onOpenChange={setOpen}
        worktreeId={worktree.id}
        executionHostId="local"
        worktreeName={worktree.displayName}
        error={error ?? ''}
      />
    </>
  ) : null
}

function footerButtons(): string[] {
  return Array.from(document.querySelectorAll('[data-slot="dialog-footer"] button')).map(
    (button) => button.getAttribute('aria-label') ?? button.textContent ?? ''
  )
}

function button(label: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.getAttribute('aria-label') === label
  )
}

async function renderFailure(available = true) {
  getBranchRenameFailureOutput.mockResolvedValue(null)
  getBranchAutoRenameRetryAvailability.mockResolvedValue({ available, runningAttemptId: null })
  useAppStore.setState({
    worktreesByRepo: {
      repo1: [
        makeWorktree({
          id: 'repo1::/path/wt1',
          repoId: 'repo1',
          firstAgentMessageRenameError: EXCERPT_ERROR
        })
      ]
    }
  })
  await act(async () => root.render(<WorkspaceFailure />))
}

function setStoredError(error: string | null) {
  const [worktree] = useAppStore.getState().worktreesByRepo.repo1
  useAppStore.setState({
    worktreesByRepo: { repo1: [{ ...worktree, firstAgentMessageRenameError: error }] }
  })
}

let container: HTMLDivElement
let root: Root

beforeEach(() => {
  vi.clearAllMocks()
  getBranchAutoRenameRetryAvailability.mockResolvedValue({
    available: false,
    runningAttemptId: null
  })
  useAppStore.setState({ updateWorktreeMeta })
  Object.assign(window, {
    api: {
      worktrees: {
        getBranchRenameFailureOutput,
        updateMeta,
        getBranchAutoRenameRetryAvailability,
        retryBranchAutoRename,
        onBranchAutoRenameAttempt
      },
      nativeChat: { getConversationNameFailureOutput: getBranchRenameFailureOutput },
      ui: { writeClipboardText }
    }
  })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

const ignoreOpenChange = (_open: boolean): void => {}

const EXCERPT_ERROR = 'Pi CLI command failed with code 1: No API key found for github-copilot.'

describe('AutoRenameFailedDialog retry', () => {
  it('offers only Dismiss when retry is unavailable for this workspace', async () => {
    await renderFailure(false)
    expect(footerButtons()).toEqual(['Dismiss'])
  })

  it('disables both buttons while naming, then closes when the branch is renamed', async () => {
    await renderFailure()
    expect(footerButtons()).toEqual(['Dismiss', 'Try again'])
    const attempt = Promise.withResolvers<BranchAutoRenameRetryResult>()
    retryBranchAutoRename.mockReturnValue(attempt.promise)
    await act(async () => button('Try again')?.click())
    expect(button('Naming branch…')?.getAttribute('aria-disabled')).toBe('true')
    expect(button('Dismiss')?.disabled).toBe(true)
    await act(async () => button('Naming branch…')?.click())
    expect(retryBranchAutoRename).toHaveBeenCalledTimes(1)

    setStoredError(null)
    await act(async () =>
      attempt.resolve({ attemptId: 1, outcome: { kind: 'renamed' }, finishedAt: 1 })
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
    expect(container.textContent).not.toContain('rename failed')
  })

  it('shows the new error, stamped, when Try again fails again', async () => {
    await renderFailure()
    retryBranchAutoRename.mockImplementation(async () => {
      setStoredError('Codex CLI timed out after 60s')
      return { attemptId: 2, outcome: { kind: 'failed' }, finishedAt: Date.UTC(2026, 0, 1, 9, 5) }
    })
    await act(async () => button('Try again')?.click())
    const dialog = document.querySelector('[role="dialog"]')?.textContent ?? ''
    expect(dialog).toContain('Codex CLI timed out after 60s')
    expect(dialog).toMatch(/Error details · \S/)
    expect(footerButtons()).toEqual(['Dismiss', 'Try again'])
  })

  it('keeps a final reason open with Dismiss only after the error clears', async () => {
    await renderFailure()
    retryBranchAutoRename.mockImplementation(async () => {
      setStoredError(null)
      return {
        attemptId: 3,
        outcome: { kind: 'ineligible', reason: 'branch-pushed' },
        finishedAt: 1
      }
    })
    await act(async () => button('Try again')?.click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.querySelector('h2')?.textContent).toBe('Branch name kept')
    expect(dialog?.textContent).toContain('The branch was pushed, so Orca kept its name.')
    expect(dialog?.textContent).not.toContain('Error details')
    expect(button('Copy error')).toBeUndefined()
    expect(footerButtons()).toEqual(['Dismiss'])
  })

  it('shows nothing-yet as the body line, without error details, and keeps Try again', async () => {
    await renderFailure()
    retryBranchAutoRename.mockResolvedValue({
      attemptId: 4,
      outcome: { kind: 'nothing-yet' },
      finishedAt: 1
    })
    await act(async () => button('Try again')?.click())
    const dialog = document.querySelector('[role="dialog"]')
    expect(dialog?.querySelector('h2')?.textContent).toBe('Branch auto-name failed')
    expect(dialog?.textContent).toContain('No changes to name this branch from yet.')
    expect(dialog?.textContent).not.toContain("Orca couldn't generate")
    expect(button('Copy error')).toBeUndefined()
    expect(footerButtons()).toEqual(['Dismiss', 'Try again'])
  })

  it('follows a newer attempt that starts while an older one is tracked', async () => {
    await renderFailure()
    const id = 'repo1::/path/wt1'
    await act(async () =>
      emitAttempt({ executionHostId: 'local', worktreeId: id, attemptId: 1, phase: 'started' })
    )
    await act(async () =>
      emitAttempt({ executionHostId: 'local', worktreeId: id, attemptId: 2, phase: 'started' })
    )
    await act(async () =>
      emitAttempt({
        executionHostId: 'local',
        worktreeId: id,
        attemptId: 1,
        phase: 'finished',
        outcome: { kind: 'deferred', reason: 'branch-changed' },
        finishedAt: 1
      })
    )
    expect(button('Naming branch…')).toBeDefined()
    setStoredError(null)
    await act(async () =>
      emitAttempt({
        executionHostId: 'local',
        worktreeId: id,
        attemptId: 2,
        phase: 'finished',
        outcome: { kind: 'renamed' },
        finishedAt: 2
      })
    )
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('ignores an earlier attempt’s late reply after a newer attempt finished', async () => {
    await renderFailure()
    const first = Promise.withResolvers<BranchAutoRenameRetryResult>()
    retryBranchAutoRename.mockReturnValueOnce(first.promise)
    await act(async () => button('Try again')?.click())
    const id = 'repo1::/path/wt1'
    await act(async () =>
      emitAttempt({ executionHostId: 'local', worktreeId: id, attemptId: 1, phase: 'started' })
    )
    await act(async () =>
      emitAttempt({
        executionHostId: 'local',
        worktreeId: id,
        attemptId: 1,
        phase: 'finished',
        outcome: { kind: 'nothing-yet' },
        finishedAt: 1
      })
    )
    retryBranchAutoRename.mockResolvedValueOnce({
      attemptId: 2,
      outcome: { kind: 'ineligible', reason: 'branch-pushed' },
      finishedAt: 2
    })
    await act(async () => button('Try again')?.click())
    await act(async () =>
      first.resolve({ attemptId: 1, outcome: { kind: 'nothing-yet' }, finishedAt: 1 })
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'The branch was pushed, so Orca kept its name.'
    )
    expect(footerButtons()).toEqual(['Dismiss'])
  })

  it('does not resurrect an attempt that finished before the availability reply', async () => {
    const availability = Promise.withResolvers<{
      available: boolean
      runningAttemptId: number | null
    }>()
    getBranchAutoRenameRetryAvailability.mockReturnValue(availability.promise)
    getBranchRenameFailureOutput.mockResolvedValue(null)
    useAppStore.setState({
      worktreesByRepo: {
        repo1: [
          makeWorktree({
            id: 'repo1::/path/wt1',
            repoId: 'repo1',
            firstAgentMessageRenameError: EXCERPT_ERROR
          })
        ]
      }
    })
    await act(async () => root.render(<WorkspaceFailure />))
    const id = 'repo1::/path/wt1'
    await act(async () =>
      emitAttempt({ executionHostId: 'local', worktreeId: id, attemptId: 9, phase: 'started' })
    )
    await act(async () =>
      emitAttempt({
        executionHostId: 'local',
        worktreeId: id,
        attemptId: 9,
        phase: 'finished',
        outcome: { kind: 'failed' },
        finishedAt: 1
      })
    )
    await act(async () => availability.resolve({ available: true, runningAttemptId: 9 }))
    expect(button('Dismiss')?.disabled).toBe(false)
    expect(button('Try again')).toBeDefined()
    expect(button('Naming branch…')).toBeUndefined()
  })

  it('follows an automatic attempt that starts and finishes while the dialog is open', async () => {
    await renderFailure()
    await act(async () =>
      emitAttempt({
        executionHostId: 'local',
        worktreeId: 'repo1::/path/wt1',
        attemptId: 7,
        phase: 'started'
      })
    )
    expect(button('Dismiss')?.disabled).toBe(true)
    expect(button('Naming branch…')).toBeDefined()
    await act(async () =>
      emitAttempt({
        executionHostId: 'local',
        worktreeId: 'repo1::/path/wt1',
        attemptId: 7,
        phase: 'finished',
        outcome: { kind: 'deferred', reason: 'branch-changed' },
        finishedAt: 1
      })
    )
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(
      'The branch changed while Orca was naming it.'
    )
    expect(button('Dismiss')?.disabled).toBe(false)
  })
})

describe('AutoRenameFailedDialog sessions and focus', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function Controlled({
    open,
    host = 'local',
    onOpenChange = ignoreOpenChange
  }: {
    open: boolean
    host?: ExecutionHostId
    onOpenChange?: (open: boolean) => void
  }) {
    return (
      <AutoRenameFailedDialog
        open={open}
        onOpenChange={onOpenChange}
        worktreeId="repo1::/path/wt1"
        executionHostId={host}
        worktreeName="Nautilus"
        error={EXCERPT_ERROR}
      />
    )
  }

  it('never lets a local attempt drive a same-id dialog on another host', async () => {
    getBranchRenameFailureOutput.mockResolvedValue(null)
    const onOpenChange = vi.fn()
    await act(async () =>
      root.render(<Controlled open host="runtime:paired-env" onOpenChange={onOpenChange} />)
    )
    const event = { executionHostId: 'local', worktreeId: 'repo1::/path/wt1' } as const
    await act(async () => emitAttempt({ ...event, attemptId: 3, phase: 'started' }))
    expect(button('Dismiss')?.disabled).toBe(false)
    await act(async () =>
      emitAttempt({
        ...event,
        attemptId: 3,
        phase: 'finished',
        outcome: { kind: 'renamed' },
        finishedAt: 1
      })
    )
    expect(onOpenChange).not.toHaveBeenCalled()
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(EXCERPT_ERROR)
  })

  it('ignores an availability reply from a closed session after reopening', async () => {
    getBranchRenameFailureOutput.mockResolvedValue(null)
    const stale = Promise.withResolvers<{ available: boolean; runningAttemptId: number | null }>()
    getBranchAutoRenameRetryAvailability.mockReturnValueOnce(stale.promise)
    getBranchAutoRenameRetryAvailability.mockResolvedValueOnce({
      available: true,
      runningAttemptId: null
    })
    await act(async () => root.render(<Controlled open />))
    await act(async () => root.render(<Controlled open={false} />))
    await act(async () => root.render(<Controlled open />))
    await act(async () => stale.resolve({ available: true, runningAttemptId: 5 }))
    expect(button('Dismiss')?.disabled).toBe(false)
    expect(button('Try again')).toBeDefined()
  })

  function queueFrames(): FrameRequestCallback[] {
    const frames: FrameRequestCallback[] = []
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((frame) => {
      frames.push(frame)
      return frames.length
    })
    return frames
  }

  it('does not take back focus the user moved before the queued focus runs', async () => {
    const frames = queueFrames()
    await renderFailure()
    retryBranchAutoRename.mockResolvedValue({
      attemptId: 1,
      outcome: { kind: 'nothing-yet' },
      finishedAt: 1
    })
    button('Try again')?.focus()
    await act(async () => button('Try again')?.click())
    button('Dismiss')?.focus()
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss')
  })

  it('moves focus to Dismiss when a kept name removes the focused Try again', async () => {
    const frames = queueFrames()
    await renderFailure()
    retryBranchAutoRename.mockResolvedValue({
      attemptId: 1,
      outcome: { kind: 'ineligible', reason: 'branch-renamed' },
      finishedAt: 1
    })
    button('Try again')?.focus()
    await act(async () => button('Try again')?.click())
    // Radix's focus scope moves focus to the dialog container when the focused button unmounts.
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')
    dialog?.setAttribute('tabindex', '-1')
    dialog?.focus()
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss')
  })

  it('does not focus a dialog that started closing before the queued focus runs', async () => {
    const frames = queueFrames()
    await renderFailure()
    retryBranchAutoRename.mockResolvedValue({
      attemptId: 1,
      outcome: { kind: 'nothing-yet' },
      finishedAt: 1
    })
    const tryAgain = button('Try again')
    tryAgain?.focus()
    await act(async () => tryAgain?.click())
    // Radix keeps a closing dialog connected, marked closed, through its exit animation.
    document.querySelector('[role="dialog"]')?.setAttribute('data-state', 'closed')
    document.body.focus()
    tryAgain?.blur()
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    expect(document.activeElement).not.toBe(button('Try again'))
  })

  it('does not focus a reopened dialog from the previous session’s queued focus', async () => {
    const frames = queueFrames()
    getBranchRenameFailureOutput.mockResolvedValue(null)
    getBranchAutoRenameRetryAvailability.mockResolvedValue({
      available: true,
      runningAttemptId: null
    })
    retryBranchAutoRename.mockResolvedValue({
      attemptId: 1,
      outcome: { kind: 'nothing-yet' },
      finishedAt: 1
    })
    await act(async () => root.render(<Controlled open />))
    button('Try again')?.focus()
    await act(async () => button('Try again')?.click())
    await act(async () => root.render(<Controlled open={false} />))
    await act(async () => root.render(<Controlled open />))
    button('Dismiss')?.focus()
    await act(async () => frames.splice(0).forEach((frame) => frame(0)))
    expect(document.activeElement?.getAttribute('aria-label')).toBe('Dismiss')
  })

  it('re-announces an identical result by clearing the live region while naming runs', async () => {
    await renderFailure()
    const liveRegion = () => document.querySelector('[aria-live="polite"]')?.textContent ?? ''
    retryBranchAutoRename.mockResolvedValueOnce({
      attemptId: 1,
      outcome: { kind: 'nothing-yet' },
      finishedAt: 1
    })
    await act(async () => button('Try again')?.click())
    expect(liveRegion()).toBe('No changes to name this branch from yet.')
    const second = Promise.withResolvers<BranchAutoRenameRetryResult>()
    retryBranchAutoRename.mockReturnValueOnce(second.promise)
    await act(async () => button('Try again')?.click())
    expect(liveRegion()).toBe('')
    await act(async () =>
      second.resolve({ attemptId: 2, outcome: { kind: 'nothing-yet' }, finishedAt: 1 })
    )
    expect(liveRegion()).toBe('No changes to name this branch from yet.')
  })
})
