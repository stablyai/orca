// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useTaskCreationDraftRetention } from './use-task-creation-draft-retention'

type Draft = { title: string; body: string }

const emptyDraft = (): Draft => ({ title: '', body: '' })

describe('useTaskCreationDraftRetention', () => {
  it('does not fan out writes while typing and saves the latest text on dismissal', () => {
    const writeDraft = vi.fn()
    const view = renderHook(
      ({ open, draft }) => useTaskCreationDraftRetention({ open, draft, writeDraft }),
      { initialProps: { open: true, draft: emptyDraft() } }
    )

    view.rerender({ open: true, draft: { title: 'Bug', body: '' } })
    view.rerender({ open: true, draft: { title: 'Bug', body: 'Latest details' } })

    expect(writeDraft).not.toHaveBeenCalled()

    view.rerender({ open: false, draft: emptyDraft() })

    expect(writeDraft).toHaveBeenCalledOnce()
    expect(writeDraft).toHaveBeenCalledWith({ title: 'Bug', body: 'Latest details' })
  })

  it('saves the latest text when an open composer unmounts', () => {
    const writeDraft = vi.fn()
    const view = renderHook(
      ({ draft }) => useTaskCreationDraftRetention({ open: true, draft, writeDraft }),
      { initialProps: { draft: { title: 'First', body: '' } } }
    )
    view.rerender({ draft: { title: 'Latest', body: 'Details' } })

    view.unmount()

    expect(writeDraft).toHaveBeenCalledOnce()
    expect(writeDraft).toHaveBeenCalledWith({ title: 'Latest', body: 'Details' })
  })

  it('clears a successful draft without resurrecting it during close cleanup', () => {
    const writeDraft = vi.fn()
    const view = renderHook(
      ({ open }) =>
        useTaskCreationDraftRetention({
          open,
          draft: { title: 'Created', body: 'Details' },
          writeDraft
        }),
      { initialProps: { open: true } }
    )

    act(() => view.result.current())
    view.rerender({ open: false })
    view.unmount()

    expect(writeDraft).toHaveBeenCalledOnce()
    expect(writeDraft).toHaveBeenCalledWith(null)
  })

  it('does not create a draft when an unopened composer unmounts', () => {
    const writeDraft = vi.fn()
    const view = renderHook(() =>
      useTaskCreationDraftRetention({ open: false, draft: emptyDraft(), writeDraft })
    )

    view.unmount()

    expect(writeDraft).not.toHaveBeenCalled()
  })
})
