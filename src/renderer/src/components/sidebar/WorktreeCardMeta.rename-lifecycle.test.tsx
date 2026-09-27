// @vitest-environment happy-dom

import { useState } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type * as HoverCardModule from '@/components/ui/hover-card'
import { WorktreeCardDetailsHover } from './WorktreeCardMeta'
import { WorktreeTitleInlineRename } from './WorktreeTitleInlineRename'
import { useWorktreeCardDetailsHoverControl } from './worktree-card-details-hover-state'

const hoverEvents = vi.hoisted(() => ({
  close: (_open: boolean): void => {},
  observed: vi.fn()
}))

vi.mock('@/components/ui/hover-card', async (importOriginal) => {
  const actual = await importOriginal<typeof HoverCardModule>()
  return {
    ...actual,
    HoverCard: (props: React.ComponentProps<typeof actual.HoverCard>) => {
      hoverEvents.close = props.onOpenChange ?? (() => {})
      return (
        <actual.HoverCard
          {...props}
          onOpenChange={(open) => {
            hoverEvents.observed(open)
            props.onOpenChange?.(open)
          }}
        />
      )
    }
  }
})

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))
vi.mock('@/components/SelectedTextCopyMenu', () => ({
  SelectedTextCopyMenu: ({ children }: { children: React.ReactNode }) => children
}))
vi.mock('./WorktreeContextMenu', () => ({
  WORKTREE_NATIVE_CONTEXT_MENU_ATTR: 'data-native-menu'
}))
vi.mock('@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover', () => ({
  WorkspaceEmojiSuggestionPopover: () => null
}))
vi.mock('@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput', () => ({
  useWorkspaceEmojiShortcodeInput: ({
    onValueChange
  }: {
    onValueChange: (value: string) => void
  }) => ({
    close: vi.fn(),
    handleKeyDown: () => false,
    handleValueChange: onValueChange,
    open: false,
    syncCursor: vi.fn()
  })
}))

afterEach(() => {
  cleanup()
  hoverEvents.observed.mockClear()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function Harness({ onRename }: { onRename: (title: string) => Promise<void> }): React.JSX.Element {
  const [disabled, setDisabled] = useState(false)
  const control = useWorktreeCardDetailsHoverControl()
  return (
    <>
      <button onClick={() => control.handleHoverOpenChange(true)}>Open hover</button>
      <button onClick={() => control.handleHoverOpenChange(false)}>Request close</button>
      <button
        onClick={() => {
          control.closeHover()
          setDisabled(true)
        }}
      >
        Begin sidebar edit
      </button>
      <button onClick={() => setDisabled(false)}>End sidebar edit</button>
      <WorktreeCardDetailsHover
        issue={null}
        linearIssue={null}
        review={null}
        comment={null}
        workspaceTitle="Hover workspace"
        branchName="branch"
        disabled={disabled}
        hoverControl={control}
        onRenameWorkspaceTitle={onRename}
      >
        <div data-testid="identity-trigger">Identity</div>
      </WorktreeCardDetailsHover>
    </>
  )
}

function InlineFocusHarness({ wrapped }: { wrapped: boolean }): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  const control = useWorktreeCardDetailsHoverControl()
  const title = (
    <WorktreeTitleInlineRename
      displayName="Inline workspace"
      onRename={() => {}}
      onEditingChange={(next) => {
        if (next) {
          control.closeHover()
        }
        setEditing(next)
      }}
    />
  )
  return wrapped ? (
    <WorktreeCardDetailsHover
      disabled={editing}
      hoverControl={control}
      openDelay={100}
      issue={null}
      linearIssue={null}
      review={null}
      comment={null}
      workspaceTitle="Inline workspace"
    >
      <div>{title}</div>
    </WorktreeCardDetailsHover>
  ) : (
    title
  )
}

function content(): Element | null {
  return document.querySelector('[data-slot="hover-card-content"]')
}

async function openEditor(): Promise<HTMLInputElement> {
  fireEvent.click(screen.getByText('Open hover'))
  const title = await screen.findByText('Hover workspace')
  fireEvent.doubleClick(title)
  return screen.getByRole<HTMLInputElement>('textbox', { name: 'Rename workspace' })
}

function retainClosingAnimation(): void {
  const original = globalThis.getComputedStyle
  vi.spyOn(globalThis, 'getComputedStyle').mockImplementation((node) => {
    const style = original(node)
    if (node.getAttribute('data-slot') !== 'hover-card-content') {
      return style
    }
    Object.defineProperties(style, {
      animationName: {
        configurable: true,
        get: () => (node.getAttribute('data-state') === 'closed' ? 'exit' : 'enter')
      },
      display: { configurable: true, value: 'block' }
    })
    return style
  })
}

describe('hover editor lifetime with the real Radix portal', () => {
  it.each([false, true])(
    'does not reopen a disabled pending save (external close: %s)',
    async (requestClose) => {
      let finishSave = (): void => {}
      const save = new Promise<void>((resolve) => {
        finishSave = resolve
      })
      const onRename = vi.fn(() => save)
      render(<Harness onRename={onRename} />)
      const trigger = screen.getByTestId('identity-trigger')
      const editor = await openEditor()
      fireEvent.change(editor, { target: { value: 'Saved title' } })
      if (requestClose) {
        fireEvent.click(screen.getByText('Request close'))
      }
      fireEvent.keyDown(editor, { key: 'Enter' })
      expect(onRename).toHaveBeenCalledExactlyOnceWith('Saved title')
      fireEvent.click(screen.getByText('Begin sidebar edit'))
      await waitFor(() => expect(content()).toBeNull())
      expect(screen.getByTestId('identity-trigger')).toBe(trigger)
      await act(async () => {
        finishSave()
        await save
      })
      fireEvent.click(screen.getByText('End sidebar edit'))
      expect(content()).toBeNull()
      expect(screen.getByTestId('identity-trigger')).toBe(trigger)
      const freshEditor = await openEditor()
      fireEvent.change(freshEditor, { target: { value: 'Fresh title' } })
      fireEvent.keyDown(freshEditor, { key: 'Enter' })
      await waitFor(() => expect(screen.queryByRole('textbox')).toBeNull())
      expect(onRename).toHaveBeenLastCalledWith('Fresh title')
      fireEvent.click(screen.getByText('Request close'))
      await waitFor(() => expect(content()).toBeNull())
    }
  )

  it('keeps normal pending internal editing open until save settles', async () => {
    let finishSave = (): void => {}
    const save = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    render(<Harness onRename={() => save} />)
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: 'Saved title' } })
    fireEvent.click(screen.getByText('Request close'))
    fireEvent.keyDown(editor, { key: 'Enter' })
    expect(content()).not.toBeNull()
    await act(async () => {
      finishSave()
      await save
    })
    await waitFor(() => expect(content()).toBeNull())
  })
  it.each(['cancel', 'save', 'pointer-leave'] as const)(
    'honors internal close with %s after save starts',
    async (mode) => {
      let finishSave = (): void => {}
      const save = new Promise<void>((resolve) => {
        finishSave = resolve
      })
      render(<Harness onRename={() => save} />)
      const editor = await openEditor()
      fireEvent.change(editor, { target: { value: 'Saved title' } })
      if (mode === 'cancel') {
        act(() => {
          hoverEvents.close(false)
          fireEvent.keyDown(editor, { key: 'Escape' })
        })
      } else {
        fireEvent.keyDown(editor, { key: 'Enter' })
        if (mode === 'pointer-leave') {
          const portal = content()
          if (!portal) {
            throw new Error('Missing real hover portal')
          }
          fireEvent.pointerLeave(portal, { pointerType: 'mouse' })
          await waitFor(() => expect(hoverEvents.observed).toHaveBeenCalledWith(false))
          expect(content()).not.toBeNull()
        }
        await act(async () => {
          if (mode === 'save') {
            hoverEvents.close(false)
          }
          finishSave()
          await save
        })
      }
      await waitFor(() => expect(content()).toBeNull())
    }
  )
  it('immediately removes disabled content before its closing animation completes', async () => {
    retainClosingAnimation()
    let finishSave = (): void => {}
    const save = new Promise<void>((resolve) => {
      finishSave = resolve
    })
    render(<Harness onRename={() => save} />)
    const trigger = screen.getByTestId('identity-trigger')
    const editor = await openEditor()
    fireEvent.change(editor, { target: { value: 'Saved title' } })
    fireEvent.keyDown(editor, { key: 'Enter' })
    fireEvent.click(screen.getByText('Begin sidebar edit'))
    expect(content()).toBeNull()
    fireEvent.click(screen.getByText('End sidebar edit'))
    expect(content()).toBeNull()
    expect(screen.getByTestId('identity-trigger')).toBe(trigger)
    await act(async () => {
      finishSave()
      await save
    })
    expect(content()).toBeNull()
    await openEditor()
  })

  it('retains ordinary closing content until animationend in the animation control', async () => {
    retainClosingAnimation()
    render(<Harness onRename={async () => {}} />)
    fireEvent.click(screen.getByText('Open hover'))
    await screen.findByText('Hover workspace')
    fireEvent.click(screen.getByText('Request close'))
    const portal = content()
    if (!portal) {
      throw new Error('Missing retained closing portal')
    }
    expect(portal.getAttribute('data-state')).toBe('closed')
    const end = new Event('animationend', { bubbles: true })
    Object.defineProperty(end, 'animationName', { value: 'exit' })
    fireEvent(portal, end)
    await waitFor(() => expect(content()).toBeNull())
  })
  it.each([false, true])('preserves input touch defaults (retained trigger: %s)', (wrapped) => {
    const title = (
      <WorktreeTitleInlineRename displayName="Sidebar workspace" beginEditing onRename={() => {}} />
    )
    render(
      wrapped ? (
        <WorktreeCardDetailsHover
          disabled
          issue={null}
          linearIssue={null}
          review={null}
          comment={null}
          workspaceTitle="Sidebar workspace"
        >
          <div>{title}</div>
        </WorktreeCardDetailsHover>
      ) : (
        title
      )
    )
    const input = screen.getByRole('textbox', { name: 'Rename workspace' })
    const touch = new Event('touchstart', { bubbles: true, cancelable: true })
    expect(fireEvent(input, touch)).toBe(true)
    expect(touch.defaultPrevented).toBe(false)
  })
  it.each([false, true])(
    'does not open hover after inline focus and quick cancel (wrapped: %s)',
    async (wrapped) => {
      vi.useFakeTimers()
      const captureFocus = vi.fn()
      render(
        <div onFocusCapture={captureFocus}>
          <InlineFocusHarness wrapped={wrapped} />
        </div>
      )
      fireEvent.doubleClick(screen.getByText('Inline workspace'))
      const input = screen.getByRole('textbox', { name: 'Rename workspace' })
      expect(document.activeElement).toBe(input)
      expect(captureFocus).toHaveBeenCalledOnce()
      fireEvent.keyDown(input, { key: 'Escape' })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(content()).toBeNull()
      expect(hoverEvents.observed).not.toHaveBeenCalledWith(true)
    }
  )
  it('rejects a pre-edit pointer timer and permits fresh pointer intent after cancel', async () => {
    vi.useFakeTimers()
    render(<InlineFocusHarness wrapped />)
    const title = screen.getByText('Inline workspace')
    fireEvent.pointerEnter(title, { pointerType: 'mouse' })
    fireEvent.doubleClick(title)
    fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename workspace' }), { key: 'Escape' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(hoverEvents.observed).toHaveBeenCalledWith(true)
    expect(content()).toBeNull()
    const freshTitle = screen.getByText('Inline workspace')
    fireEvent.pointerLeave(freshTitle, { pointerType: 'mouse' })
    fireEvent.pointerEnter(freshTitle, { pointerType: 'mouse' })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(200)
    })
    expect(content()).not.toBeNull()
  })
  it.each([
    { pointerType: 'touch', pendingMouse: false },
    { pointerType: 'touch', pendingMouse: true },
    { pointerType: 'pen', pendingMouse: false },
    { pointerType: 'pen', pendingMouse: true }
  ])(
    'preserves Radix $pointerType eligibility with pending mouse=$pendingMouse',
    async ({ pointerType, pendingMouse }) => {
      vi.useFakeTimers()
      render(<InlineFocusHarness wrapped />)
      const title = screen.getByText('Inline workspace')
      if (pendingMouse) {
        fireEvent.pointerEnter(title, { pointerType: 'mouse' })
      }
      fireEvent.doubleClick(title)
      fireEvent.keyDown(screen.getByRole('textbox', { name: 'Rename workspace' }), {
        key: 'Escape'
      })
      fireEvent.pointerEnter(screen.getByText('Inline workspace'), { pointerType })
      await act(async () => {
        await vi.advanceTimersByTimeAsync(200)
      })
      expect(Boolean(content())).toBe(pointerType === 'pen')
    }
  )
})
