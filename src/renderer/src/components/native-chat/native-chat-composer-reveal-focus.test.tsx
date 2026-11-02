// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, createElement, useRef, useState } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import {
  captureNativeChatComposerFocusIntent,
  requestNativeChatComposerFocus,
  useNativeChatComposerRevealFocus
} from './use-native-chat-composer-reveal-focus'
import {
  handleOverlayCloseAutoFocus,
  registerOverlayFocusOwner
} from '@/lib/overlay-focus-ownership'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'
import { Sheet, SheetContent, SheetTitle } from '@/components/ui/sheet'
import { NativeChatMentionMenu, NativeChatPickerMenu } from './NativeChatAutocompleteMenus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

type HarnessProps = {
  tabId?: string
  suggestions?: 'slash' | 'mention'
  isVisible: boolean
  isFocusedGroup: boolean
  composerReady?: boolean
  /** Composer handle is unavailable until this many focus attempts have run. */
  readyAfterAttempts?: number
  onFocus?: () => void
  /** Rerender-only churn, to prove the latch holds. */
  nonce?: number
}

let container: HTMLDivElement
let root: Root
let frames: (() => void)[] = []
let focusCalls = 0

function drainFrames(max = 20): void {
  for (let i = 0; i < max && frames.length > 0; i += 1) {
    const queued = frames
    frames = []
    act(() => {
      for (const frame of queued) {
        frame()
      }
    })
  }
}

function Harness(props: HarnessProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  const fieldRef = useRef<HTMLTextAreaElement>(null)
  const attemptsRef = useRef(0)
  const composerRef = useRef<NativeChatComposerHandle>(null)
  composerRef.current = {
    focus: () => {
      attemptsRef.current += 1
      focusCalls += 1
      props.onFocus?.()
      if (attemptsRef.current <= (props.readyAfterAttempts ?? 0)) {
        return false
      }
      fieldRef.current?.focus()
      return true
    },
    insertTypedText: () => true,
    insertAgentReferences: () => false,
    appendText: () => {},
    acceptsText: () => true,
    handlePasteEvent: () => {},
    pasteFromClipboard: () => {},
    contains: (node) => fieldRef.current?.contains(node) === true
  }
  useNativeChatComposerRevealFocus({
    tabId: props.tabId ?? 'chat-tab',
    rootRef,
    composerRef,
    isVisible: props.isVisible,
    isFocusedGroup: props.isFocusedGroup,
    composerReady: props.composerReady ?? true,
    scheduleFrame: (callback) => {
      frames.push(callback)
    }
  })
  return createElement(
    'div',
    { ref: rootRef },
    createElement('textarea', { ref: fieldRef, 'data-testid': 'composer' }),
    createElement('button', { type: 'button', 'data-testid': 'in-pane-button' }),
    createElement('input', { 'data-testid': 'find-input' }),
    createElement('input', { 'data-testid': 'question-input' }),
    props.suggestions === 'slash' ? (
      <NativeChatPickerMenu
        autocomplete={{
          mode: 'slash',
          prefix: '/',
          query: '',
          triggerKey: '/',
          items: [],
          dispatchable: true,
          grouped: false,
          commandsEnabled: true,
          skillsEnabled: false,
          skillStatus: 'ready'
        }}
        activeIndex={0}
        listboxId="slash-suggestions"
        onChoose={() => {}}
        onRetry={() => {}}
      />
    ) : null,
    props.suggestions === 'mention' ? (
      <NativeChatMentionMenu
        mention={{ files: [], loading: false, failed: false }}
        activeIndex={0}
        listboxId="mention-suggestions"
        onChoose={() => {}}
      />
    ) : null
  )
}

function render(props: HarnessProps): void {
  act(() => {
    root.render(createElement(Harness, props))
  })
}

function mountOverlay(role: 'menu' | 'dialog' = 'menu'): HTMLDivElement {
  const overlay = document.createElement('div')
  overlay.setAttribute('role', role)
  overlay.setAttribute('data-state', 'open')
  overlay.tabIndex = -1
  document.body.appendChild(overlay)
  overlay.focus()
  return overlay
}

function dismissOverlay(overlay: HTMLElement, remove = true): void {
  overlay.setAttribute('data-state', 'closed')
  const event = new Event('focusScope.autoFocusOnUnmount')
  overlay.addEventListener(event.type, handleOverlayCloseAutoFocus, { once: true })
  overlay.dispatchEvent(event)
  if (remove) {
    overlay.remove()
  }
}

beforeEach(() => {
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  frames = []
  focusCalls = 0
})

afterEach(() => {
  document.dispatchEvent(new Event('pointerdown'))
  act(() => {
    root.unmount()
  })
  container.remove()
  document.body.innerHTML = ''
})

describe('useNativeChatComposerRevealFocus', () => {
  it('claims the composer again when its revealed tab is activated', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    const tab = document.createElement('div')
    tab.tabIndex = 0
    document.body.append(tab)
    tab.focus()

    act(() => requestNativeChatComposerFocus('chat-tab'))
    expect(container.querySelector('textarea')).toBe(document.activeElement)
    drainFrames()

    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('takes focus from a control inside the pane when its tab is activated', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    const button = container.querySelector('button')
    act(() => {
      button?.focus()
    })

    act(() => requestNativeChatComposerFocus('chat-tab'))
    drainFrames()

    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('leaves the find input alone when its tab is activated', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    const findInput = container.querySelector('input')
    act(() => {
      findInput?.focus()
    })
    const before = focusCalls

    act(() => requestNativeChatComposerFocus('chat-tab'))
    drainFrames()

    expect(focusCalls).toBe(before)
    expect(document.activeElement).toBe(findInput)
  })

  it('does not carry an unfinished tab activation into a later reveal', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    act(() => requestNativeChatComposerFocus('chat-tab'))
    render({ isVisible: false, isFocusedGroup: true })
    const button = container.querySelector('button')
    act(() => {
      button?.focus()
    })
    const before = focusCalls

    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()

    expect(focusCalls).toBe(before)
    expect(document.activeElement).toBe(button)
  })

  it('delivers a created tab request after its composer mounts and becomes ready', () => {
    render({ tabId: 'source-tab', isVisible: true, isFocusedGroup: true })
    drainFrames()
    const sourceComposer = container.querySelector('textarea')
    expect(document.activeElement).toBe(sourceComposer)

    const intent = captureNativeChatComposerFocusIntent()
    intent.request('chat-tab')
    drainFrames()
    expect(document.activeElement).toBe(sourceComposer)

    const destination = document.createElement('div')
    document.body.appendChild(destination)
    const destinationRoot = createRoot(destination)
    act(() => {
      root.render(
        createElement(Harness, { tabId: 'source-tab', isVisible: true, isFocusedGroup: false })
      )
      destinationRoot.render(
        createElement(Harness, { isVisible: true, isFocusedGroup: false, composerReady: false })
      )
    })
    drainFrames()
    expect(document.activeElement).toBe(sourceComposer)

    act(() => {
      destinationRoot.render(
        createElement(Harness, { isVisible: true, isFocusedGroup: true, composerReady: false })
      )
    })
    drainFrames()
    expect(document.activeElement).toBe(sourceComposer)
    act(() => {
      destinationRoot.render(
        createElement(Harness, { isVisible: true, isFocusedGroup: true, composerReady: true })
      )
    })
    drainFrames()
    expect(document.activeElement).toBe(destination.querySelector('textarea'))
    const before = focusCalls
    if (document.activeElement instanceof HTMLElement) {
      document.activeElement.blur()
    }
    act(() => requestNativeChatComposerFocus('other-tab'))
    drainFrames()
    expect(focusCalls).toBe(before)
    act(() => destinationRoot.unmount())
    destination.remove()
  })

  it('focuses when it mounts already revealed', () => {
    render({ isVisible: true, isFocusedGroup: true })
    expect(focusCalls).toBe(0)
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('focuses on the isVisible edge', () => {
    render({ isVisible: false, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('focuses on the isFocusedGroup edge alone', () => {
    render({ isVisible: true, isFocusedGroup: false })
    drainFrames()
    expect(focusCalls).toBe(0)
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('hands focus from a sibling composer to the newly focused pane', () => {
    const other = document.createElement('div')
    other.setAttribute('data-retained-pane-host', '')
    document.body.appendChild(other)
    const otherRoot = createRoot(other)
    act(() => {
      root.render(createElement(Harness, { isVisible: true, isFocusedGroup: true }))
      otherRoot.render(
        createElement(Harness, { tabId: 'other-tab', isVisible: true, isFocusedGroup: false })
      )
    })
    other.querySelector('textarea')?.focus()
    drainFrames()
    expect(focusCalls).toBe(0)
    expect(other.querySelector('textarea')).toBe(document.activeElement)

    act(() => requestNativeChatComposerFocus('chat-tab'))
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(container.querySelector('textarea')).toBe(document.activeElement)

    for (const field of ['find-input', 'question-input']) {
      const sourceInput = other.querySelector<HTMLInputElement>(`[data-testid="${field}"]`)
      sourceInput?.focus()
      act(() => requestNativeChatComposerFocus('chat-tab'))
      drainFrames()
      expect(document.activeElement).toBe(sourceInput)
    }
    expect(focusCalls).toBe(1)

    const sourceComposer = other.querySelector('textarea')
    sourceComposer?.focus()
    const delayedIntent = captureNativeChatComposerFocusIntent()
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
    delayedIntent.request('chat-tab')
    drainFrames()
    expect(document.activeElement).toBe(sourceComposer)

    act(() => {
      otherRoot.unmount()
    })
    other.remove()
  })

  it('holds the latch across unrelated rerenders', () => {
    render({ isVisible: true, isFocusedGroup: true, nonce: 1 })
    drainFrames()
    expect(focusCalls).toBe(1)
    render({ isVisible: true, isFocusedGroup: true, nonce: 2 })
    render({ isVisible: true, isFocusedGroup: true, nonce: 3 })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('reclaims focus after delayed programmatic restoration', () => {
    render({ isVisible: true, isFocusedGroup: true, nonce: 1 })
    drainFrames(1)
    expect(focusCalls).toBe(1)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    act(() => {
      outside.focus()
    })
    drainFrames()
    expect(focusCalls).toBe(2)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
    outside.remove()
  })

  it.each(['menu', 'dialog'] as const)(
    'preserves a newer %s when the composer becomes ready',
    (role) => {
      render({ isVisible: true, isFocusedGroup: true, composerReady: false })
      const intent = captureNativeChatComposerFocusIntent()
      intent.request('chat-tab')
      const overlay = mountOverlay(role)

      render({ isVisible: true, isFocusedGroup: true, composerReady: true })
      drainFrames()

      expect(document.activeElement).toBe(overlay)
      expect(focusCalls).toBe(0)
      overlay.remove()
      render({ isVisible: true, isFocusedGroup: true, nonce: 1 })
      drainFrames()
      expect(document.activeElement).toBe(document.body)
    }
  )

  it.each([
    { dismissal: 'removed', readyAfterAttempts: 0 },
    { dismissal: 'closed', readyAfterAttempts: 0 },
    { dismissal: 'closed', readyAfterAttempts: 1 }
  ])(
    'hands launch focus to a ready composer ($dismissal, retries: $readyAfterAttempts)',
    async ({ dismissal, readyAfterAttempts }) => {
      render({ isVisible: true, isFocusedGroup: true, composerReady: false })
      const menu = mountOverlay()
      const search = document.createElement('input')
      menu.appendChild(search)
      search.focus()
      const intent = captureNativeChatComposerFocusIntent()
      intent.request('chat-tab')

      render({ isVisible: true, isFocusedGroup: true, readyAfterAttempts })
      drainFrames()
      expect(document.activeElement).toBe(search)
      expect(focusCalls).toBe(0)

      await act(async () => {
        dismissOverlay(menu, dismissal === 'removed')
      })
      drainFrames()
      expect(document.activeElement).toBe(container.querySelector('textarea'))
    }
  )

  it.each([false, true])(
    'hands launch focus to a late composer (tab published after dismissal: %s)',
    async (lateTab) => {
      render({ isVisible: true, isFocusedGroup: true, composerReady: false })
      const menu = mountOverlay()
      const intent = captureNativeChatComposerFocusIntent()
      if (!lateTab) {
        intent.request('chat-tab')
      }
      await act(async () => dismissOverlay(menu))
      if (lateTab) {
        intent.request('chat-tab')
      }

      render({ isVisible: true, isFocusedGroup: true })
      drainFrames()

      expect(document.activeElement).toBe(container.querySelector('textarea'))
    }
  )

  it('waits for both the launch menu and its portaled setup to dismiss', async () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    const menu = mountOverlay()
    const setup = mountOverlay('dialog')
    const intent = captureNativeChatComposerFocusIntent()
    act(() => intent.request('chat-tab'))
    drainFrames()
    const before = focusCalls

    await act(async () => dismissOverlay(menu))
    drainFrames()
    expect(document.activeElement).toBe(setup)
    expect(focusCalls).toBe(before)

    await act(async () => dismissOverlay(setup))
    drainFrames()
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  it.each(['menu', 'dialog'] as const)(
    'cancels a launch handoff when a newer %s opens before the source closes',
    async (role) => {
      render({ isVisible: true, isFocusedGroup: true, composerReady: false })
      const source = mountOverlay()
      const intent = captureNativeChatComposerFocusIntent()
      intent.request('chat-tab')
      render({ isVisible: true, isFocusedGroup: true })
      drainFrames()

      let newer: HTMLDivElement
      await act(async () => {
        newer = mountOverlay(role)
        registerOverlayFocusOwner(newer)
      })
      await act(async () => {
        source.remove()
        newer.remove()
      })
      drainFrames()

      expect(document.activeElement).toBe(document.body)
      expect(focusCalls).toBe(0)
    }
  )

  it.each(['pointer', 'Tab', 'expiry'] as const)(
    'cancels a source menu handoff after %s',
    async (cancellation) => {
      vi.useFakeTimers()
      try {
        render({ isVisible: true, isFocusedGroup: true, composerReady: false })
        const menu = mountOverlay()
        const intent = captureNativeChatComposerFocusIntent()
        intent.request('chat-tab')
        render({ isVisible: true, isFocusedGroup: true })
        drainFrames()

        if (cancellation === 'pointer') {
          document.dispatchEvent(new Event('pointerdown'))
        } else if (cancellation === 'Tab') {
          document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab' }))
        } else {
          act(() => vi.advanceTimersByTime(1000))
        }
        await act(async () => dismissOverlay(menu))
        drainFrames()

        expect(document.activeElement).toBe(document.body)
        expect(focusCalls).toBe(0)
      } finally {
        vi.useRealTimers()
      }
    }
  )

  it('cancels queued focus recovery when a menu opens between frames', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames(1)
    const menu = mountOverlay()

    drainFrames(1)

    expect(document.activeElement).toBe(menu)
    expect(focusCalls).toBe(1)
    menu.remove()
    drainFrames()
    expect(document.activeElement).toBe(document.body)
  })

  it.each([false, true])(
    'yields an immediate focus request to a menu (onlyIfFocusUnclaimed: %s)',
    (onlyIfFocusUnclaimed) => {
      render({ isVisible: true, isFocusedGroup: true })
      const menu = mountOverlay()
      menu.blur()

      act(() => requestNativeChatComposerFocus('chat-tab', { onlyIfFocusUnclaimed }))
      menu.remove()
      drainFrames()

      expect(document.activeElement).toBe(document.body)
      expect(focusCalls).toBe(0)
    }
  )

  it.each(['slash', 'mention'] as const)(
    'reclaims focus after switching away from %s suggestions',
    (mode) => {
      render({ isVisible: true, isFocusedGroup: true, suggestions: mode })
      drainFrames()
      expect(document.querySelector('[role="listbox"]')).not.toBeNull()
      render({ isVisible: false, isFocusedGroup: true, suggestions: mode })
      const tab = document.createElement('button')
      document.body.append(tab)
      tab.focus()

      render({ isVisible: true, isFocusedGroup: true, suggestions: mode })
      drainFrames()
      expect(document.activeElement).toBe(container.querySelector('textarea'))
      tab.focus()
      act(() => requestNativeChatComposerFocus('chat-tab'))
      drainFrames()
      expect(document.activeElement).toBe(container.querySelector('textarea'))
    }
  )

  it('launches a floating chat above persistent Skills content while protecting a nested popup', async () => {
    const page = document.createElement('div')
    page.setAttribute('role', 'listbox')
    page.dataset.focusBehavior = 'page'
    document.body.append(page)
    render({ isVisible: true, isFocusedGroup: true, composerReady: false })
    const intent = captureNativeChatComposerFocusIntent()
    intent.request('chat-tab')
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(document.activeElement).toBe(container.querySelector('textarea'))

    const popup = mountOverlay()
    page.append(popup)
    popup.focus()
    const before = focusCalls
    render({ isVisible: false, isFocusedGroup: true })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(document.activeElement).toBe(popup)
    expect(focusCalls).toBe(before)
    await act(async () => dismissOverlay(popup))
    drainFrames()
    expect(focusCalls).toBe(before)
  })

  it('delivers an active-tab handoff after both dashboard scopes dismiss and trigger focus restores', async () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    const sheet = mountOverlay('dialog')
    registerOverlayFocusOwner(sheet)
    const preview = mountOverlay('dialog')
    registerOverlayFocusOwner(preview)
    sheet.setAttribute('aria-hidden', 'true')
    const trigger = document.createElement('button')
    document.body.append(trigger)
    act(() => requestNativeChatComposerFocus('chat-tab'))
    drainFrames()
    expect(document.activeElement).toBe(preview)

    await act(async () => {
      dismissOverlay(preview)
      sheet.removeAttribute('aria-hidden')
    })
    drainFrames()
    expect(document.activeElement).not.toBe(container.querySelector('textarea'))
    await act(async () => {
      dismissOverlay(sheet)
      trigger.focus()
    })
    drainFrames()
    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  it('hands an existing draft through real sheet and dialog dismissal callbacks', async () => {
    vi.useFakeTimers()
    function Dashboard(): React.JSX.Element {
      const [open, setOpen] = useState(false)
      return (
        <>
          <Harness isVisible isFocusedGroup />
          <button onClick={() => setOpen(true)}>Dashboard preview</button>
          <Sheet open={open} onOpenChange={setOpen} modal={false}>
            <SheetContent aria-describedby={undefined}>
              <SheetTitle>Dashboard</SheetTitle>
              <Dialog open={open} onOpenChange={setOpen}>
                <DialogContent aria-describedby={undefined}>
                  <DialogTitle>Preview</DialogTitle>
                  <button
                    onClick={() => {
                      requestNativeChatComposerFocus('chat-tab')
                      setOpen(false)
                    }}
                  >
                    Open worktree
                  </button>
                </DialogContent>
              </Dialog>
            </SheetContent>
          </Sheet>
        </>
      )
    }
    try {
      act(() => root.render(<Dashboard />))
      drainFrames()
      const composer = container.querySelector('textarea')!
      composer.value = 'Existing draft'
      await act(async () => {
        ;[...container.querySelectorAll('button')]
          .find((button) => button.textContent === 'Dashboard preview')!
          .click()
      })
      expect(document.querySelector('[data-slot="dialog-content"]')).not.toBeNull()
      const action = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Open worktree'
      )!
      await act(async () => action.click())
      await act(async () => vi.advanceTimersByTime(0))
      drainFrames()
      expect(document.activeElement).toBe(composer)
      expect(composer.value).toBe('Existing draft')
    } finally {
      vi.useRealTimers()
    }
  })

  it('allows focus recovery while a dismissed menu animates out', () => {
    const menu = mountOverlay()
    menu.setAttribute('data-state', 'closed')

    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()

    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  it('allows a chat hosted inside a dialog to claim its composer', () => {
    const dialog = mountOverlay('dialog')
    dialog.appendChild(container)

    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()

    expect(document.activeElement).toBe(container.querySelector('textarea'))
  })

  it('does not chase focus after the user moves to a control outside the pane', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames(1)
    expect(focusCalls).toBe(1)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    act(() => {
      outside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
      outside.focus()
    })
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('does not cancel a scheduled claim when the user types immediately', () => {
    render({ isVisible: true, isFocusedGroup: true })
    act(() => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true }))
    })
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('does not chase focus after the user tabs away', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames(1)
    expect(focusCalls).toBe(1)
    const outside = document.createElement('button')
    document.body.appendChild(outside)
    act(() => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true })
      )
      outside.focus()
    })
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('leaves focus on a non-editable control inside the pane', () => {
    render({ isVisible: false, isFocusedGroup: true })
    const button = container.querySelector('button')
    act(() => {
      button?.focus()
    })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
    expect(document.activeElement).toBe(button)
  })

  it('re-arms after the pane is hidden and revealed again', () => {
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    render({ isVisible: false, isFocusedGroup: true })
    drainFrames()
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(2)
  })

  it('retries across frames until the composer takes focus', () => {
    render({ isVisible: true, isFocusedGroup: true, readyAfterAttempts: 2 })
    drainFrames()
    expect(focusCalls).toBe(3)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('gives up after a bounded number of attempts', () => {
    render({ isVisible: true, isFocusedGroup: true, readyAfterAttempts: 99 })
    drainFrames()
    expect(focusCalls).toBe(6)
  })

  it('waits for a composer that is not ready yet, then focuses', () => {
    render({ isVisible: true, isFocusedGroup: true, composerReady: false })
    drainFrames()
    expect(focusCalls).toBe(0)
    render({ isVisible: true, isFocusedGroup: true, composerReady: true })
    drainFrames()
    expect(focusCalls).toBe(1)
  })

  it('re-arms when a prompt replaces an already focused composer', () => {
    render({ isVisible: true, isFocusedGroup: true, composerReady: true })
    drainFrames()
    expect(focusCalls).toBe(1)

    render({ isVisible: true, isFocusedGroup: true, composerReady: false })
    drainFrames()
    act(() => {
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
    })
    render({ isVisible: true, isFocusedGroup: true, composerReady: true })
    drainFrames()

    expect(focusCalls).toBe(2)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
  })

  it('leaves focus alone when it is already inside the pane', () => {
    render({ isVisible: false, isFocusedGroup: true })
    const field = container.querySelector('textarea')
    act(() => {
      field?.focus()
    })
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
  })

  it('leaves a live text field outside the pane alone', () => {
    const outside = document.createElement('input')
    document.body.appendChild(outside)
    outside.focus()
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(0)
    expect(document.activeElement).toBe(outside)
    outside.remove()
  })

  it('claims focus from the composer of the chat tab hidden by the same switch', () => {
    const hiddenPane = document.createElement('div')
    const previousComposer = document.createElement('textarea')
    hiddenPane.appendChild(previousComposer)
    document.body.appendChild(hiddenPane)
    previousComposer.focus()
    render({ isVisible: false, isFocusedGroup: true })
    // Chromium leaves focus on the hidden field until a later task, after the reveal claim runs.
    hiddenPane.setAttribute('inert', '')
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(container.querySelector('textarea')).toBe(document.activeElement)
    hiddenPane.remove()
  })

  it('still claims focus from the covered xterm helper textarea', () => {
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    document.body.appendChild(helper)
    helper.focus()
    render({ isVisible: true, isFocusedGroup: true })
    drainFrames()
    expect(focusCalls).toBe(1)
    expect(container.querySelector('textarea')).toBe(document.activeElement)
    helper.remove()
  })
})
