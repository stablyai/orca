// @vitest-environment happy-dom

import { useLayoutEffect } from 'react'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAppearanceLeaveDialog } from './use-appearance-leave-dialog'

function deferred<T>(): {
  promise: Promise<T>
  resolve: (value: T) => void
} {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((next) => {
    resolve = next
  })
  return { promise, resolve }
}

afterEach(cleanup)

describe('useAppearanceLeaveDialog', () => {
  it('allows leaving immediately when there are no changes', async () => {
    const saveDraft = vi.fn(async () => true)
    const discardDraft = vi.fn()
    const hook = renderHook(() =>
      useAppearanceLeaveDialog({ hasChanges: false, saveDraft, discardDraft })
    )

    await expect(hook.result.current.confirmLeave({ discardDraftOnLeave: true })).resolves.toBe(
      true
    )

    expect(hook.result.current.open).toBe(false)
    expect(saveDraft).not.toHaveBeenCalled()
    expect(discardDraft).not.toHaveBeenCalled()
  })

  it('resolves the pending decision as false when cancelled', async () => {
    const hook = renderHook(() =>
      useAppearanceLeaveDialog({
        hasChanges: true,
        saveDraft: vi.fn(async () => true),
        discardDraft: vi.fn()
      })
    )
    let decision!: Promise<boolean>

    act(() => {
      decision = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
    })
    expect(hook.result.current.open).toBe(true)

    act(() => hook.result.current.cancel())

    await expect(decision).resolves.toBe(false)
    expect(hook.result.current.open).toBe(false)
  })

  it.each([true, false])(
    'allows discard with discardDraftOnLeave=%s',
    async (discardDraftOnLeave) => {
      const discardDraft = vi.fn()
      const hook = renderHook(() =>
        useAppearanceLeaveDialog({
          hasChanges: true,
          saveDraft: vi.fn(async () => true),
          discardDraft
        })
      )
      let decision!: Promise<boolean>

      act(() => {
        decision = hook.result.current.confirmLeave({ discardDraftOnLeave })
      })
      act(() => hook.result.current.discard())

      await expect(decision).resolves.toBe(true)
      expect(discardDraft).toHaveBeenCalledTimes(discardDraftOnLeave ? 1 : 0)
      expect(hook.result.current.open).toBe(false)
    }
  )

  it('waits for a successful save before allowing leave', async () => {
    const pendingSave = deferred<boolean>()
    const saveDraft = vi.fn(() => pendingSave.promise)
    const hook = renderHook(() =>
      useAppearanceLeaveDialog({ hasChanges: true, saveDraft, discardDraft: vi.fn() })
    )
    let decision!: Promise<boolean>

    act(() => {
      decision = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
    })
    act(() => hook.result.current.save())

    expect(saveDraft).toHaveBeenCalledOnce()
    expect(hook.result.current.open).toBe(true)
    expect(hook.result.current.saving).toBe(true)

    await act(async () => {
      pendingSave.resolve(true)
      expect(await decision).toBe(true)
    })

    expect(hook.result.current.open).toBe(false)
    expect(hook.result.current.saving).toBe(false)
  })

  it('keeps a failed save open and allows retrying', async () => {
    const saveDraft = vi
      .fn()
      .mockRejectedValueOnce(new Error('save failed'))
      .mockResolvedValueOnce(true)
    const hook = renderHook(() =>
      useAppearanceLeaveDialog({ hasChanges: true, saveDraft, discardDraft: vi.fn() })
    )
    let decision!: Promise<boolean>

    act(() => {
      decision = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
    })
    act(() => hook.result.current.save())

    await waitFor(() => expect(hook.result.current.saveFailed).toBe(true))
    expect(hook.result.current.open).toBe(true)
    expect(hook.result.current.saving).toBe(false)

    await act(async () => {
      hook.result.current.save()
      expect(await decision).toBe(true)
    })

    expect(saveDraft).toHaveBeenCalledTimes(2)
    expect(hook.result.current.open).toBe(false)
    expect(hook.result.current.saveFailed).toBe(false)
  })

  it('shares one pending decision across duplicate leave requests', async () => {
    const hook = renderHook(() =>
      useAppearanceLeaveDialog({
        hasChanges: true,
        saveDraft: vi.fn(async () => true),
        discardDraft: vi.fn()
      })
    )
    let first!: Promise<boolean>
    let duplicate!: Promise<boolean>

    act(() => {
      first = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
      duplicate = hook.result.current.confirmLeave({ discardDraftOnLeave: false })
    })

    expect(duplicate).toBe(first)
    act(() => hook.result.current.cancel())
    await expect(Promise.all([first, duplicate])).resolves.toEqual([false, false])
  })

  it('syncs fresh edits before caller layout effects can request leave', async () => {
    const onDecision = vi.fn<(decision: Promise<boolean>) => void>()
    const saveDraft = vi.fn(async () => true)
    const discardDraft = vi.fn()
    const hook = renderHook(
      ({ hasChanges }) => {
        const dialog = useAppearanceLeaveDialog({ hasChanges, saveDraft, discardDraft })
        const { confirmLeave } = dialog
        useLayoutEffect(() => {
          if (hasChanges) {
            onDecision(confirmLeave({ discardDraftOnLeave: true }))
          }
        }, [confirmLeave, hasChanges])
        return dialog
      },
      { initialProps: { hasChanges: false } }
    )

    hook.rerender({ hasChanges: true })

    expect(onDecision).toHaveBeenCalledOnce()
    expect(hook.result.current.open).toBe(true)
    const decision = onDecision.mock.calls[0]?.[0]
    if (!decision) {
      throw new Error('Expected a pending leave decision')
    }
    act(() => hook.result.current.cancel())
    await expect(decision).resolves.toBe(false)
  })

  it('cancels a pending leave decision when the dialog owner unmounts', async () => {
    const hook = renderHook(() =>
      useAppearanceLeaveDialog({
        hasChanges: true,
        saveDraft: vi.fn(async () => true),
        discardDraft: vi.fn()
      })
    )
    let decision!: Promise<boolean>

    act(() => {
      decision = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
    })
    hook.unmount()

    await expect(decision).resolves.toBe(false)
  })

  it('blocks actions during an external save and leaves when that save finishes', async () => {
    const pendingSave = deferred<boolean>()
    const saveDraft = vi.fn(() => pendingSave.promise)
    const discardDraft = vi.fn()
    const hook = renderHook(
      ({ hasChanges, draftSaving }) =>
        useAppearanceLeaveDialog({
          hasChanges,
          draftSaving,
          saveDraft,
          discardDraft
        }),
      { initialProps: { hasChanges: true, draftSaving: true } }
    )
    let decision!: Promise<boolean>

    act(() => {
      decision = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
    })
    expect(saveDraft).toHaveBeenCalledOnce()
    expect(hook.result.current.open).toBe(true)
    expect(hook.result.current.saving).toBe(true)

    act(() => {
      hook.result.current.save()
      hook.result.current.discard()
      hook.result.current.cancel()
    })

    expect(discardDraft).not.toHaveBeenCalled()
    expect(hook.result.current.open).toBe(true)

    await act(async () => {
      pendingSave.resolve(true)
      hook.rerender({ hasChanges: false, draftSaving: false })
    })

    await expect(decision).resolves.toBe(true)
    expect(hook.result.current.open).toBe(false)
  })

  it('keeps the leave decision open when edits remain after an in-flight save', async () => {
    const pendingSave = deferred<boolean>()
    const saveDraft = vi.fn(() => pendingSave.promise)
    const hook = renderHook(
      ({ hasChanges, draftSaving }) =>
        useAppearanceLeaveDialog({
          hasChanges,
          draftSaving,
          saveDraft,
          discardDraft: vi.fn()
        }),
      { initialProps: { hasChanges: true, draftSaving: true } }
    )
    let decision!: Promise<boolean>

    act(() => {
      decision = hook.result.current.confirmLeave({ discardDraftOnLeave: true })
    })

    await act(async () => {
      pendingSave.resolve(false)
      await pendingSave.promise
      hook.rerender({ hasChanges: true, draftSaving: false })
    })

    expect(hook.result.current.open).toBe(true)
    expect(hook.result.current.saving).toBe(false)
    act(() => hook.result.current.cancel())
    await expect(decision).resolves.toBe(false)
  })
})
