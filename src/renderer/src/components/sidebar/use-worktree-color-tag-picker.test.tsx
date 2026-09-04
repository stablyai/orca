// @vitest-environment happy-dom

import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Worktree } from '../../../../shared/worktree/types'
import { useWorktreeColorTagPicker } from './use-worktree-color-tag-picker'
import { useAppStore } from '@/store'
import { CLOSE_ALL_CONTEXT_MENUS_EVENT } from './worktree-context-menu-policy'
import { getWorkspaceColorTagIdentity } from '../../../../shared/workspace-color-tag'
import {
  clearWorkspaceColorTagPreviews,
  createWorkspaceColorTagPreviewOwner,
  setWorkspaceColorTagPreviews
} from './workspace-color-tag-preview'

vi.mock('./WorktreeColorTagPickerPopover', () => ({
  WorktreeColorTagPickerPopover: (props: { open: boolean }) => (
    <div data-testid="picker" data-open={props.open} />
  )
}))

function worktree(colorTag: string | null): Worktree {
  return { id: `w-${colorTag}`, colorTag } as unknown as Worktree
}

function isOpen(picker: React.JSX.Element): boolean {
  return (picker.props as { open: boolean }).open
}

const POINT = { x: 10, y: 20 }

function args(
  contextWorktrees: readonly Worktree[],
  onAssignColorTag = vi.fn(),
  restoreMenuFocus = vi.fn(),
  onActiveChange = vi.fn()
) {
  return {
    contextWorktrees,
    menuPoint: POINT,
    disabled: false,
    isMultiContext: contextWorktrees.length > 1,
    onAssignColorTag,
    restoreMenuFocus,
    onActiveChange
  }
}

function render(selection: readonly Worktree[], restoreMenuFocus = vi.fn()) {
  const view = renderHook(() =>
    useWorktreeColorTagPicker(args(selection, vi.fn(), restoreMenuFocus))
  )
  return { ...view, restoreMenuFocus }
}

describe('workspace color tag picker handoff', () => {
  afterEach(() => vi.useRealTimers())

  // Regression: the menu plays an exit animation, so its onCloseAutoFocus lands *after* a
  // timer-opened popover. The focus restore then pulled focus out of the popover and Radix
  // dismissed it, so the custom swatch appeared to close both surfaces.
  it('suppresses the menu focus restore while a picker is pending', () => {
    vi.useFakeTimers()
    const { result, restoreMenuFocus } = render([worktree(null)])

    act(() => result.current.openPicker())
    const event = new Event('closeAutoFocus', { cancelable: true })
    act(() => result.current.handleMenuCloseAutoFocus(event))

    expect(restoreMenuFocus).not.toHaveBeenCalled()
    expect(event.defaultPrevented).toBe(true)
  })

  it('opens only after the menu has finished tearing down', () => {
    vi.useFakeTimers()
    const { result, rerender } = render([worktree(null)])

    act(() => result.current.openPicker())
    rerender()
    expect(isOpen(result.current.picker)).toBe(false)

    act(() => result.current.handleMenuCloseAutoFocus(new Event('x', { cancelable: true })))
    act(() => vi.advanceTimersByTime(0))
    rerender()
    expect(isOpen(result.current.picker)).toBe(true)
  })

  it('still opens when the menu never reports close-auto-focus', () => {
    vi.useFakeTimers()
    const { result, rerender } = render([worktree(null)])

    act(() => result.current.openPicker())
    act(() => vi.advanceTimersByTime(250))
    rerender()
    expect(isOpen(result.current.picker)).toBe(true)
  })

  // Regression: a right-click on another card during the menu's exit animation broadcast close-all,
  // but the pending handoff still opened this picker over the new menu with the old selection.
  it('cancels a pending handoff when another context menu opens', () => {
    vi.useFakeTimers()
    const onActiveChange = vi.fn()
    const { result, rerender } = renderHook(() =>
      useWorktreeColorTagPicker(args([worktree(null)], vi.fn(), vi.fn(), onActiveChange))
    )

    act(() => result.current.openPicker())
    expect(onActiveChange).toHaveBeenLastCalledWith(true)
    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    })
    act(() => result.current.handleMenuCloseAutoFocus(new Event('x', { cancelable: true })))
    act(() => vi.advanceTimersByTime(250))
    rerender()

    expect(isOpen(result.current.picker)).toBe(false)
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  // Regression: after close-all cancelled the handoff, the old menu's late close-auto-focus saw no
  // pending picker and focused the sidebar, a focus-outside that dismissed the newly opened menu.
  it('restores no focus for the superseded menu, once, after a cancelled handoff', () => {
    vi.useFakeTimers()
    const { result, restoreMenuFocus } = render([worktree(null)])

    act(() => result.current.openPicker())
    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    })
    const late = new Event('x', { cancelable: true })
    act(() => result.current.handleMenuCloseAutoFocus(late))
    expect(restoreMenuFocus).not.toHaveBeenCalled()
    expect(late.defaultPrevented).toBe(true)

    const next = new Event('y', { cancelable: true })
    act(() => result.current.handleMenuCloseAutoFocus(next))
    expect(restoreMenuFocus).toHaveBeenCalledWith(next)
  })

  // Regression: once the picker was open, a later close-all was ignored; a keyboard or synthetic
  // context-menu open has no pointer-down outside, so Radix later committed the draft and restored
  // focus under the new menu.
  it('closes an already-open picker, without a focus restore, when another context menu opens', () => {
    vi.useFakeTimers()
    const onActiveChange = vi.fn()
    const restoreMenuFocus = vi.fn()
    const { result, rerender } = renderHook(() =>
      useWorktreeColorTagPicker(args([worktree(null)], vi.fn(), restoreMenuFocus, onActiveChange))
    )
    act(() => result.current.openPicker())
    act(() => result.current.handleMenuCloseAutoFocus(new Event('x', { cancelable: true })))
    act(() => vi.advanceTimersByTime(0))
    rerender()
    expect(isOpen(result.current.picker)).toBe(true)

    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    })
    rerender()
    expect(isOpen(result.current.picker)).toBe(false)
    const restore = new Event('r', { cancelable: true })
    act(() =>
      (result.current.picker.props as { onRestoreFocus: (e: Event) => void }).onRestoreFocus(
        restore
      )
    )
    expect(restoreMenuFocus).not.toHaveBeenCalled()
    expect(restore.defaultPrevented).toBe(true)
    act(() => vi.advanceTimersByTime(500))
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('forgets a cancelled handoff once the close-auto-focus window has passed', () => {
    vi.useFakeTimers()
    const { result, restoreMenuFocus } = render([worktree(null)])

    act(() => result.current.openPicker())
    act(() => {
      window.dispatchEvent(new Event(CLOSE_ALL_CONTEXT_MENUS_EVENT))
    })
    act(() => vi.advanceTimersByTime(250))
    const event = new Event('x', { cancelable: true })
    act(() => result.current.handleMenuCloseAutoFocus(event))
    expect(restoreMenuFocus).toHaveBeenCalledWith(event)
  })

  it('runs the menu focus restore normally when no picker is pending', () => {
    const { result, restoreMenuFocus } = render([worktree(null)])
    const event = new Event('x', { cancelable: true })

    act(() => result.current.handleMenuCloseAutoFocus(event))

    expect(restoreMenuFocus).toHaveBeenCalledWith(event)
    expect(event.defaultPrevented).toBe(false)
  })

  it('opens once, not twice, when the fallback and the handoff both fire', () => {
    vi.useFakeTimers()
    const { result, rerender } = render([worktree(null)])

    act(() => result.current.openPicker())
    act(() => result.current.handleMenuCloseAutoFocus(new Event('x', { cancelable: true })))
    act(() => vi.advanceTimersByTime(500))
    rerender()

    expect(isOpen(result.current.picker)).toBe(true)
  })

  it('seeds the picker from a uniformly tagged selection', () => {
    const { result } = render([worktree('#ef4444'), worktree('#ef4444')])
    expect(result.current.sharedColorTag).toBe('#ef4444')
  })

  it('seeds the picker as untagged when the selection is mixed', () => {
    const { result } = render([worktree('#ef4444'), worktree('#22c55e')])
    expect(result.current.sharedColorTag).toBeNull()
  })

  // Regression: the menu's rows are a snapshot taken when it opened; once a pending folder write
  // landed and its preview cleared, the row fell back to the pre-write color and the toggle inverted.
  it('reads the live store row before the frozen menu row', () => {
    const frozen = { id: 'repo1::/live', colorTag: null } as unknown as Worktree
    const before = useAppStore.getState().worktreesByRepo
    try {
      act(() =>
        useAppStore.setState({
          worktreesByRepo: { repo1: [{ ...frozen, colorTag: '#22c55e' }] }
        } as never)
      )
      const { result } = render([frozen])
      expect(result.current.sharedColorTag).toBe('#22c55e')
    } finally {
      act(() => useAppStore.setState({ worktreesByRepo: before } as never))
    }
  })

  // Regression: the custom picker seeded from the frozen rows, so opening it during a pending write
  // started the wheel at the previous color rather than the one on the card.
  it('seeds the custom picker from what the card shows', () => {
    vi.useFakeTimers()
    const owner = createWorkspaceColorTagPreviewOwner()
    const row = worktree(null)
    const key = getWorkspaceColorTagIdentity(row)
    try {
      act(() => setWorkspaceColorTagPreviews([key], '#ef4444', owner))
      const { result, rerender } = render([row])
      act(() => result.current.openPicker())
      rerender()
      expect((result.current.picker.props as { colorTag: string | null }).colorTag).toBe('#ef4444')
    } finally {
      act(() => clearWorkspaceColorTagPreviews([key], owner))
    }
  })

  // Regression: a preset write still in flight showed on the card through the preview channel, but
  // the row read the store, so reopening the menu computed the toggle from the old value.
  it('reads a pending preview as the shared color so the toggle matches the card', () => {
    const owner = createWorkspaceColorTagPreviewOwner()
    const row = worktree(null)
    const key = getWorkspaceColorTagIdentity(row)
    try {
      act(() => setWorkspaceColorTagPreviews([key], '#ef4444', owner))
      const { result } = render([row])
      expect(result.current.sharedColorTag).toBe('#ef4444')
    } finally {
      act(() => clearWorkspaceColorTagPreviews([key], owner))
    }
  })
})

describe('workspace color tag picker selection snapshot', () => {
  type PickerProps = { onCommitColorTag: (colorTag: string | null) => void }

  // Regression: a folder row passes no selection and the menu's context set only exists while the
  // menu is open, so a picker reading the live selection previewed and committed one workspace
  // when several were right-clicked.
  it('commits to the selection snapshotted when the picker opened, not the live one', () => {
    vi.useFakeTimers()
    const onAssign = vi.fn()
    const first = [worktree('#111111'), worktree(null)]
    const second = [worktree(null)]
    const { result, rerender } = renderHook(
      ({ selection }: { selection: readonly Worktree[] }) =>
        useWorktreeColorTagPicker(args(selection, onAssign)),
      { initialProps: { selection: first } }
    )

    act(() => result.current.openPicker())
    rerender({ selection: second })
    act(() => (result.current.picker.props as PickerProps).onCommitColorTag('#222222'))

    expect(onAssign).toHaveBeenCalledWith('#222222', first)
    vi.useRealTimers()
  })

  it('reports a mixed selection with no shared tag', () => {
    const { result } = renderHook(() =>
      useWorktreeColorTagPicker(args([worktree('#ef4444'), worktree(null)]))
    )
    expect(result.current.mixed).toBe(true)
    expect(result.current.sharedColorTag).toBeNull()
  })
})

describe('workspace color tag picker menu lifecycle', () => {
  afterEach(() => vi.useRealTimers())

  type PickerProps = { onOpenChange: (open: boolean) => void }

  // Regression: an Agent Map host completes the menu lifecycle on a 0 ms timer once the menu
  // closes. The model must be told a picker is pending before that, or it tears the host down
  // before the handoff can open the popover.
  it('marks the model active the moment the custom swatch is chosen', () => {
    vi.useFakeTimers()
    const onActiveChange = vi.fn()
    const { result } = renderHook(() =>
      useWorktreeColorTagPicker(args([worktree(null)], vi.fn(), vi.fn(), onActiveChange))
    )

    act(() => result.current.openPicker())

    expect(onActiveChange).toHaveBeenCalledWith(true)
    expect(onActiveChange).not.toHaveBeenCalledWith(false)
  })

  it('releases the model only after the popover has had time to animate out', () => {
    vi.useFakeTimers()
    const onActiveChange = vi.fn()
    const { result, rerender } = renderHook(() =>
      useWorktreeColorTagPicker(args([worktree(null)], vi.fn(), vi.fn(), onActiveChange))
    )
    act(() => result.current.openPicker())
    act(() => vi.advanceTimersByTime(250))
    rerender()

    act(() => (result.current.picker.props as PickerProps).onOpenChange(false))
    expect(onActiveChange).not.toHaveBeenCalledWith(false)

    act(() => vi.advanceTimersByTime(200))
    expect(onActiveChange).toHaveBeenLastCalledWith(false)
  })

  it('does not release the model if the picker is reopened during the hold', () => {
    vi.useFakeTimers()
    const onActiveChange = vi.fn()
    const { result, rerender } = renderHook(() =>
      useWorktreeColorTagPicker(args([worktree(null)], vi.fn(), vi.fn(), onActiveChange))
    )
    act(() => result.current.openPicker())
    act(() => vi.advanceTimersByTime(250))
    rerender()
    act(() => (result.current.picker.props as PickerProps).onOpenChange(false))
    act(() => vi.advanceTimersByTime(100))
    act(() => result.current.openPicker())
    act(() => vi.advanceTimersByTime(500))

    expect(onActiveChange).not.toHaveBeenCalledWith(false)
  })
})
