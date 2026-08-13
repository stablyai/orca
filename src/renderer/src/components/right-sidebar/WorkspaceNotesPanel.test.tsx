// @vitest-environment happy-dom

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { StrictMode, type SetStateAction } from 'react'
import type * as ReactModule from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const stateTracking = vi.hoisted(() => ({ idleStateUpdates: 0 }))

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof ReactModule>()
  return {
    ...actual,
    useState: <T,>(initialState: T) => {
      const [value, setValue] = actual.useState(initialState)
      if (initialState !== 'idle') {
        return [value, setValue] as const
      }
      return [
        value,
        (next: SetStateAction<T>) => {
          stateTracking.idleStateUpdates += 1
          return setValue(next)
        }
      ] as const
    }
  }
})

type NoteTarget = {
  scopeKey: string
  executionHostId: ExecutionHostId
  displayName: string
  branch: string | null
  comment: string
}

type MockStoreState = {
  updateWorktreeMeta: ReturnType<typeof vi.fn>
}

const testState = vi.hoisted(() => ({
  target: null as NoteTarget | null,
  store: {
    updateWorktreeMeta: vi.fn()
  } as MockStoreState
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector?: (state: MockStoreState) => unknown) =>
      selector ? selector(testState.store) : testState.store,
    { getState: () => testState.store }
  )

  return { useAppStore }
})

vi.mock('./workspace-notes-state', () => ({
  selectActiveWorkspaceNote: () => testState.target
}))

import WorkspaceNotesPanel, { resetWorkspaceNoteSaveStateForTests } from './WorkspaceNotesPanel'

function worktreeTarget(overrides: Partial<NoteTarget> = {}): NoteTarget {
  return {
    scopeKey: 'worktree:repo::/repo/worktree',
    executionHostId: 'local',
    displayName: 'Existing worktree',
    branch: 'feature/notes',
    comment: 'Existing note',
    ...overrides
  }
}

async function advanceSaveTimer(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 250))
  })
}

function setupUser(): ReturnType<typeof userEvent.setup> {
  return userEvent.setup({ delay: null })
}

function panel(): React.ReactElement {
  return (
    <TooltipProvider>
      <WorkspaceNotesPanel />
    </TooltipProvider>
  )
}

describe('WorkspaceNotesPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetWorkspaceNoteSaveStateForTests()
    stateTracking.idleStateUpdates = 0
    testState.target = worktreeTarget()
    testState.store.updateWorktreeMeta.mockResolvedValue({ ok: true })
  })

  afterEach(() => {
    cleanup()
    vi.useRealTimers()
  })

  it('debounces the latest comment into the active workspace', async () => {
    const user = setupUser()
    render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' updated')

    expect(testState.store.updateWorktreeMeta).not.toHaveBeenCalled()

    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledWith(
      'worktree:repo::/repo/worktree',
      { comment: 'Existing note updated' },
      expect.objectContaining({ executionHostId: 'local' })
    )
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('saves after StrictMode replays the mounted effect', async () => {
    const user = setupUser()
    render(<StrictMode>{panel()}</StrictMode>)

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' strict mode')
    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledWith(
      'worktree:repo::/repo/worktree',
      { comment: 'Existing note strict mode' },
      expect.objectContaining({ executionHostId: 'local' })
    )
  })

  it('shows the active folder workspace note and saves its folder scope', async () => {
    const user = setupUser()
    testState.target = {
      scopeKey: 'folder:folder-1',
      executionHostId: 'local',
      displayName: 'Platform folder',
      branch: null,
      comment: ''
    }

    render(panel())

    expect(screen.getByText('Platform folder')).toBeTruthy()
    expect(screen.queryByText('feature/notes')).toBeNull()
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), 'folder note')
    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledWith(
      'folder:folder-1',
      { comment: 'folder note' },
      expect.objectContaining({ executionHostId: 'local' })
    )
  })

  it('serializes saves for the same host-scoped workspace', async () => {
    const user = setupUser()
    let resolveFirstSave!: (result: { ok: true }) => void
    testState.store.updateWorktreeMeta
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve
          })
      )
      .mockResolvedValue({ ok: true })

    render(panel())
    const note = screen.getByRole('textbox', { name: 'Workspace note' })
    await user.type(note, ' first')
    await advanceSaveTimer()

    await user.type(note, ' second')
    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstSave({ ok: true })
      await Promise.resolve()
    })

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(testState.store.updateWorktreeMeta).toHaveBeenLastCalledWith(
      'worktree:repo::/repo/worktree',
      { comment: 'Existing note first second' },
      expect.objectContaining({ executionHostId: 'local' })
    )
  })

  it('serializes an in-flight save across panel remounts', async () => {
    const user = setupUser()
    let resolveFirstSave!: (result: { ok: true }) => void
    testState.store.updateWorktreeMeta
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve
          })
      )
      .mockResolvedValue({ ok: true })

    const firstView = render(panel())
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' first')
    await advanceSaveTimer()
    firstView.unmount()

    const secondView = render(panel())
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' second')
    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(1)

    await act(async () => {
      resolveFirstSave({ ok: true })
      await Promise.resolve()
    })

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(testState.store.updateWorktreeMeta).toHaveBeenLastCalledWith(
      'worktree:repo::/repo/worktree',
      { comment: 'Existing note first second' },
      expect.objectContaining({ executionHostId: 'local' })
    )
    secondView.unmount()
  })

  it('persists a queued draft after the originating panel remounts', async () => {
    const user = setupUser()
    let resolveFirstSave!: (result: { ok: true }) => void
    testState.store.updateWorktreeMeta
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve
          })
      )
      .mockResolvedValue({ ok: true })

    const firstView = render(panel())
    const firstNote = screen.getByRole('textbox', { name: 'Workspace note' })
    await user.type(firstNote, ' first')
    await advanceSaveTimer()

    await user.type(firstNote, ' second')
    await advanceSaveTimer()
    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(1)

    firstView.unmount()
    const secondView = render(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note first second')

    await act(async () => {
      resolveFirstSave({ ok: true })
      await Promise.resolve()
    })
    await vi.waitFor(() => expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(2))

    expect(testState.store.updateWorktreeMeta).toHaveBeenLastCalledWith(
      'worktree:repo::/repo/worktree',
      { comment: 'Existing note first second' },
      expect.objectContaining({ executionHostId: 'local' })
    )
    secondView.unmount()
  })

  it('retains a queued draft while its workspace is inactive', async () => {
    const user = setupUser()
    const firstTarget = testState.target
    if (!firstTarget) {
      throw new Error('first target is required')
    }
    const secondTarget = worktreeTarget({
      scopeKey: 'worktree:repo::/repo/second',
      displayName: 'Second worktree',
      branch: 'feature/second',
      comment: 'Second note'
    })
    let resolveFirstSave!: (result: { ok: true }) => void
    testState.store.updateWorktreeMeta
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstSave = resolve
          })
      )
      .mockResolvedValue({ ok: true })

    const view = render(panel())
    const note = screen.getByRole('textbox', { name: 'Workspace note' })
    await user.type(note, ' first')
    await advanceSaveTimer()
    await user.type(note, ' second')
    await advanceSaveTimer()
    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(1)

    testState.target = secondTarget
    view.rerender(panel())
    await act(async () => {
      resolveFirstSave({ ok: true })
      await Promise.resolve()
    })

    testState.target = firstTarget
    view.rerender(panel())
    await vi.waitFor(() => expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(2))
    expect(testState.store.updateWorktreeMeta).toHaveBeenLastCalledWith(
      firstTarget.scopeKey,
      { comment: 'Existing note first second' },
      expect.objectContaining({ executionHostId: firstTarget.executionHostId })
    )
    view.unmount()
  })

  it('flushes a debounced draft when the panel unmounts before the timer fires', async () => {
    const user = setupUser()
    const firstView = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' before close')
    firstView.unmount()

    const secondView = render(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note before close')
    await vi.waitFor(() => expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(1))
    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledWith(
      'worktree:repo::/repo/worktree',
      { comment: 'Existing note before close' },
      expect.objectContaining({ executionHostId: 'local' })
    )
    secondView.unmount()
  })

  it('updates a remounted panel when an in-flight save resolves successfully', async () => {
    const user = setupUser()
    let resolveSave!: (result: { ok: true }) => void
    testState.store.updateWorktreeMeta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )

    const firstView = render(panel())
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' first')
    await advanceSaveTimer()
    expect(screen.getByText('Saving')).toBeTruthy()

    firstView.unmount()
    const secondView = render(panel())

    expect(screen.getByText('Saving')).toBeTruthy()

    await act(async () => {
      resolveSave({ ok: true })
      await Promise.resolve()
    })

    expect(screen.getByText('Saved')).toBeTruthy()
    secondView.unmount()
  })

  it('updates a remounted panel when an in-flight save fails and exposes Retry', async () => {
    const user = setupUser()
    let resolveSave!: (result: { ok: false; error: string }) => void
    testState.store.updateWorktreeMeta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )

    const firstView = render(panel())
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' edited')
    await advanceSaveTimer()
    expect(screen.getByText('Saving')).toBeTruthy()

    firstView.unmount()
    const secondView = render(panel())

    await act(async () => {
      resolveSave({ ok: false, error: 'network unavailable' })
      await Promise.resolve()
    })

    expect(screen.getByText('Could not save workspace note.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    secondView.unmount()
  })

  it('reconciles an external comment change for the same workspace', () => {
    const view = render(panel())

    testState.target = worktreeTarget({ comment: 'Updated outside the panel' })
    view.rerender(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Updated outside the panel')
  })

  it('does not replace an active local draft with an external comment change', async () => {
    const user = setupUser()
    const view = render(panel())
    const note = screen.getByRole('textbox', { name: 'Workspace note' })

    await user.type(note, ' local draft')
    testState.target = worktreeTarget({ comment: 'Updated outside the panel' })
    view.rerender(panel())

    expect((note as HTMLTextAreaElement).value).toBe('Existing note local draft')
  })

  it('renders an empty state when no workspace is selected', () => {
    testState.target = null

    render(panel())

    expect(screen.getByText('No workspace selected')).toBeTruthy()
    expect(screen.queryByRole('textbox', { name: 'Workspace note' })).toBeNull()
  })

  it('renders the current note as Markdown in Preview mode', async () => {
    testState.target = worktreeTarget({ comment: '## Heading\n\n**formatted note**' })
    const user = setupUser()

    const { container } = render(panel())
    await user.click(screen.getByRole('tab', { name: 'Preview' }))

    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
    expect(screen.getByText('Heading')).toBeTruthy()
    expect(container.querySelector('strong')?.textContent).toBe('formatted note')
  })

  it('shows one editing surface at a time with an Edit/Preview toggle', async () => {
    const user = setupUser()
    render(panel())

    expect(screen.getByRole('textbox', { name: 'Workspace note' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()

    await user.click(screen.getByRole('tab', { name: 'Preview' }))

    expect(screen.queryByRole('textbox', { name: 'Workspace note' })).toBeNull()
    expect(screen.getByText('Existing note')).toBeTruthy()

    await user.click(screen.getByRole('tab', { name: 'Edit' }))

    expect(screen.getByRole('textbox', { name: 'Workspace note' })).toBeTruthy()
    expect(screen.queryByRole('heading', { name: 'Preview' })).toBeNull()
  })

  it('retains the draft and exposes Retry after a failed save', async () => {
    const user = setupUser()
    testState.store.updateWorktreeMeta
      .mockResolvedValueOnce({ ok: false, error: 'network unavailable' })
      .mockResolvedValue({ ok: true })

    render(panel())
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' edited')
    await advanceSaveTimer()

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note edited')
    expect(screen.getByText('Could not save workspace note.')).toBeTruthy()

    await user.click(screen.getByRole('button', { name: 'Retry' }))

    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(2)
    expect(screen.getByText('Saved')).toBeTruthy()
  })

  it('preserves the draft when a failed save rolls the target back', async () => {
    const user = setupUser()
    let resolveSave!: (result: { ok: false; error: string }) => void
    testState.store.updateWorktreeMeta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    const view = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' edited')
    await advanceSaveTimer()

    testState.target = worktreeTarget({ comment: 'Existing note edited' })
    view.rerender(panel())
    testState.target = worktreeTarget({ comment: 'Existing note' })
    view.rerender(panel())

    await act(async () => {
      resolveSave({ ok: false, error: 'network unavailable' })
      await Promise.resolve()
    })

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note edited')
    expect(screen.getByText('Could not save workspace note.')).toBeTruthy()
  })

  it('preserves a failed draft across remount before the save settles', async () => {
    const user = setupUser()
    let resolveSave!: (result: { ok: false; error: string }) => void
    testState.store.updateWorktreeMeta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    const firstView = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' edited')
    await advanceSaveTimer()
    firstView.unmount()

    testState.target = worktreeTarget({ comment: 'Existing note' })
    const secondView = render(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note edited')

    await act(async () => {
      resolveSave({ ok: false, error: 'network unavailable' })
      await Promise.resolve()
    })

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note edited')
    secondView.unmount()
  })

  it('rolls back and reports an in-flight failure after switching without touching the new workspace', async () => {
    const user = setupUser()
    const firstTarget = worktreeTarget()
    const secondTarget = worktreeTarget({
      scopeKey: 'worktree:repo::/repo/second',
      displayName: 'Second worktree',
      branch: 'feature/second',
      comment: 'Second note'
    })
    let rejectSave!: (error: Error) => void
    testState.store.updateWorktreeMeta.mockImplementationOnce(
      (
        _scope: string,
        _updates: { comment: string },
        options?: { shouldApply?: (target: NoteTarget) => boolean }
      ) =>
        new Promise((resolve, reject) => {
          rejectSave = (error) => {
            if (options?.shouldApply?.(firstTarget)) {
              reject(error)
            } else {
              resolve({ ok: true })
            }
          }
        })
    )
    testState.target = firstTarget
    const view = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' edited')
    await advanceSaveTimer()
    expect(screen.getByText('Saving')).toBeTruthy()

    testState.target = secondTarget
    view.rerender(panel())

    await act(async () => {
      rejectSave(new Error('network unavailable'))
      await Promise.resolve()
    })

    expect(secondTarget.comment).toBe('Second note')
    testState.target = firstTarget
    view.rerender(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Existing note edited')
    expect(screen.getByText('Could not save workspace note.')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    view.unmount()
  })

  it('restores a pending draft and saving status when switching back to its workspace', async () => {
    const user = setupUser()
    let resolveSave!: (result: { ok: true }) => void
    testState.store.updateWorktreeMeta.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSave = resolve
        })
    )
    const view = render(panel())

    testState.target = worktreeTarget({
      scopeKey: 'worktree:repo::/repo/second',
      displayName: 'Second worktree',
      branch: 'feature/second',
      comment: 'Second note'
    })
    view.rerender(panel())
    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' pending')
    await advanceSaveTimer()

    testState.target = worktreeTarget()
    view.rerender(panel())
    testState.target = worktreeTarget({
      scopeKey: 'worktree:repo::/repo/second',
      displayName: 'Second worktree',
      branch: 'feature/second',
      comment: 'Second note'
    })
    view.rerender(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Second note pending')
    expect(screen.getByText('Saving')).toBeTruthy()

    await act(async () => {
      resolveSave({ ok: true })
      await Promise.resolve()
    })
    view.unmount()
  })

  it('does not save a draft after the workspace selector becomes null', async () => {
    const user = setupUser()
    render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' pending')
    testState.target = null
    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).not.toHaveBeenCalled()
  })

  it('does not send a scheduled draft after switching workspaces', async () => {
    const user = setupUser()
    const view = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' first draft')
    testState.target = worktreeTarget({
      scopeKey: 'worktree:repo::/repo/second',
      displayName: 'Second worktree',
      branch: 'feature/second',
      comment: 'Second note'
    })

    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).not.toHaveBeenCalled()

    view.rerender(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('Second note')
    expect(screen.getByText('Second worktree')).toBeTruthy()
  })

  it('resets and cancels a draft when the host changes for the same workspace id', async () => {
    const user = setupUser()
    const view = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' local draft')
    testState.target = worktreeTarget({
      executionHostId: 'ssh:target-a',
      comment: 'SSH note',
      displayName: 'SSH worktree'
    })

    await advanceSaveTimer()

    expect(testState.store.updateWorktreeMeta).not.toHaveBeenCalled()

    view.rerender(panel())

    expect(
      (screen.getByRole('textbox', { name: 'Workspace note' }) as HTMLTextAreaElement).value
    ).toBe('SSH note')
    expect(screen.getByText('SSH worktree')).toBeTruthy()
  })

  it('ignores an in-flight save completion after unmount', async () => {
    const user = setupUser()
    let resolveSave: ((result: { ok: true }) => void) | undefined
    testState.store.updateWorktreeMeta.mockImplementation(
      () => new Promise((resolve) => (resolveSave = resolve))
    )
    const view = render(panel())

    await user.type(screen.getByRole('textbox', { name: 'Workspace note' }), ' pending')
    await advanceSaveTimer()
    expect(testState.store.updateWorktreeMeta).toHaveBeenCalledTimes(1)
    stateTracking.idleStateUpdates = 0

    view.unmount()
    await act(async () => {
      resolveSave?.({ ok: true })
      await Promise.resolve()
    })

    expect(stateTracking.idleStateUpdates).toBe(0)
  })
})
