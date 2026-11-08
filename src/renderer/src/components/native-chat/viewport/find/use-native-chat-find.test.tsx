// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../../../shared/keybindings/types'

import { isMacPlatform } from '../../pane/routing/native-chat-shortcut'
import { NativeChatFindBar } from './NativeChatFindBar'
import { useNativeChatFind } from './use-native-chat-find'
import { useNativeChatPasteBridge } from '../../paste/use-native-chat-paste-bridge'
import { routeNativeChatRootKeyToInput } from '../../composer/focus/native-chat-root-key-routing'
import { shouldFocusNativeChatPaneFromPointerTarget } from '../../composer/focus/native-chat-typing-redirect'
import { useNativeChatComposerKeyDown } from '../../composer/editor/use-native-chat-composer-keydown'
import { useNativeChatPromptCardFocus } from '../../prompts/use-native-chat-prompt-card-focus'
import type { NativeChatComposerHandle } from '../../composer/native-chat-composer-types'

const mocks = vi.hoisted(() => {
  const bindings: { current?: KeybindingOverrides } = {}
  return { bindings, web: false }
})
vi.mock('../../../../store/index', () => ({
  useAppStore: { getState: () => ({ keybindings: mocks.bindings.current }) }
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

type Composer = NativeChatComposerHandle & { element: HTMLElement }

function composerHandle(): Composer {
  const handle: Composer = {
    element: document.createElement('div'),
    focus: vi.fn(() => {
      if (!handle.element.isConnected) {
        return false
      }
      handle.element.focus()
      return true
    }),
    insertAgentReferences: () => false,
    insertTypedText: vi.fn(() => true),
    appendText: vi.fn(),
    acceptsText: () => true,
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn(),
    contains: (node) => handle.element.contains(node)
  }
  return handle
}

function ComposerField({
  composer,
  interrupt,
  suggestionsOpen
}: {
  composer: Composer
  interrupt: () => void
  suggestionsOpen: boolean
}): React.JSX.Element {
  const dismissPicker = vi.fn()
  const onKeyDown = useNativeChatComposerKeyDown({
    autocomplete: suggestionsOpen
      ? { mode: 'mention', query: '', triggerKey: '@' }
      : { mode: 'none' },
    mentionFiles: { files: [], loading: false, failed: false },
    completeMention: vi.fn(),
    activeSuggestion: 0,
    draft: '',
    isComposing: () => false,
    completePickerItem: vi.fn(),
    dispatchPickerCommand: vi.fn(),
    dismissPicker,
    interrupt,
    send: vi.fn(),
    setActiveSuggestion: vi.fn(),
    setDraft: vi.fn(),
    setCaret: vi.fn()
  })
  return (
    <div
      ref={(node) => {
        if (node) {
          composer.element = node
        }
      }}
      role="textbox"
      aria-label="Message"
      aria-expanded={suggestionsOpen}
      contentEditable
      tabIndex={0}
      onKeyDownCapture={onKeyDown}
    />
  )
}

type ChatProps = {
  composer: Composer
  transcript: ReactNode
  enabled?: boolean
  reveal?: (match: Range, bar: DOMRectReadOnly | null) => void
  interrupt?: () => void
  suggestionsOpen?: boolean
  card?: boolean
  cardField?: boolean
}

function PromptCard({ field }: { field: boolean }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useNativeChatPromptCardFocus(ref, true)
  return (
    <div ref={ref} data-testid="card" tabIndex={-1} data-native-chat-prompt-card-focus>
      {field ? <input data-testid="card-field" data-native-chat-prompt-card-focus-target /> : null}
    </div>
  )
}

function Chat({
  composer,
  transcript,
  enabled = true,
  reveal = vi.fn(),
  interrupt = vi.fn(),
  suggestionsOpen = false,
  card = false,
  cardField = false
}: ChatProps): React.JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null)
  // As in ResolvedView: a card hides the composer and detaches its handle.
  const composerRef = { current: card ? null : composer }
  const messageListRef = useRef({ revealFindMatch: reveal })
  const find = useNativeChatFind(enabled, rootRef, composerRef, messageListRef)
  useNativeChatPasteBridge({ rootRef, composerRef })
  return (
    <div
      ref={rootRef}
      data-native-chat-root="true"
      tabIndex={-1}
      onPointerDownCapture={(event) => {
        if (event.button === 0 && shouldFocusNativeChatPaneFromPointerTarget(event.target)) {
          rootRef.current?.focus({ preventScroll: true })
        }
      }}
      onKeyDownCapture={(event) => {
        find.onKeyDownCapture(event)
        routeNativeChatRootKeyToInput(event, composerRef.current, null)
      }}
    >
      <div className="relative">
        {find.isOpen ? <NativeChatFindBar find={find} isVisible /> : null}
        <div data-native-chat-scroll>
          <div data-native-chat-transcript-column>{transcript}</div>
        </div>
      </div>
      {card ? <PromptCard field={cardField} /> : null}
      <div hidden={card}>
        <ComposerField
          composer={composer}
          interrupt={interrupt}
          suggestionsOpen={suggestionsOpen}
        />
      </div>
    </div>
  )
}

function pressModF(target: EventTarget, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', {
    key: 'f',
    code: 'KeyF',
    bubbles: true,
    cancelable: true,
    metaKey: isMacPlatform(),
    ctrlKey: !isMacPlatform(),
    ...init
  })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function press(target: EventTarget, key: string, init: KeyboardEventInit = {}): KeyboardEvent {
  const event = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init })
  act(() => {
    target.dispatchEvent(event)
  })
  return event
}

function findInput(): HTMLInputElement | null {
  const inputs = screen
    .queryAllByRole('textbox', { name: 'Find in chat' })
    .filter((element) => element instanceof HTMLInputElement)
  return inputs.find((input) => input === document.activeElement) ?? inputs[0] ?? null
}

function typeQuery(value: string): void {
  const input = findInput()
  if (!input) {
    throw new Error('find bar is not open')
  }
  fireEvent.change(input, { target: { value } })
}

function status(): string | null | undefined {
  return findInput()?.parentElement?.querySelector('[aria-live]')?.textContent
}

const TRANSCRIPT = (
  <>
    <p>alpha one</p>
    <p>
      two <strong>alpha</strong>
    </p>
    <span className="sr-only">alpha label</span>
    <div hidden>alpha collapsed</div>
    <span style={{ display: 'none' }}>alpha undisplayed</span>
    <div data-native-chat-find-skip>alpha hover-only timestamp</div>
  </>
)

beforeEach(() => {
  delete mocks.bindings.current
  mocks.web = false
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('native chat find', () => {
  it('refocuses on Mod+F without moving the match, and keeps the query on reopen', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    typeQuery('alpha')
    press(findInput()!, 'Enter')
    composer.element.focus()

    expect(pressModF(composer.element).defaultPrevented).toBe(true)
    const input = findInput()!
    expect(document.activeElement).toBe(input)
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, 5])
    expect(status()).toBe('2/2')

    press(input, 'Escape')
    expect(findInput()).toBeNull()
    pressModF(composer.element)
    expect(findInput()?.value).toBe('alpha')
  })

  it('falls back to the composer when the element find was opened from is gone', () => {
    const composer = composerHandle()
    const view = render(
      <Chat composer={composer} transcript={<button type="button">alpha</button>} />
    )
    screen.getByRole('button', { name: 'alpha' }).focus()
    pressModF(screen.getByRole('button', { name: 'alpha' }))
    view.rerender(<Chat composer={composer} transcript={<p>alpha</p>} />)
    press(findInput()!, 'Escape')
    expect(document.activeElement).toBe(composer.element)
  })

  it('Escape in the composer closes the bar first; the next Escape interrupts the turn', () => {
    const interrupt = vi.fn()
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} interrupt={interrupt} />)
    pressModF(composer.element)
    composer.element.focus()

    expect(press(composer.element, 'Escape').defaultPrevented).toBe(true)
    expect(findInput()).toBeNull()
    expect(interrupt).not.toHaveBeenCalled()
    expect(document.activeElement).toBe(composer.element)

    press(composer.element, 'Escape')
    expect(interrupt).toHaveBeenCalledTimes(1)
  })

  it('leaves Escape to an open suggestion list or a layer that already used it', () => {
    const interrupt = vi.fn()
    const composer = composerHandle()
    const view = render(
      <Chat composer={composer} transcript={TRANSCRIPT} interrupt={interrupt} suggestionsOpen />
    )
    pressModF(composer.element)
    press(composer.element, 'Escape')
    expect(findInput()).not.toBeNull()
    expect(interrupt).not.toHaveBeenCalled()

    view.rerender(<Chat composer={composer} transcript={TRANSCRIPT} interrupt={interrupt} />)
    const claimed = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    claimed.preventDefault()
    act(() => {
      composer.element.dispatchEvent(claimed)
    })
    expect(findInput()).not.toBeNull()
  })

  it('hands focus to a prompt card that arrived while find was open when find closes', () => {
    const composer = composerHandle()
    const view = render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    view.rerender(<Chat composer={composer} transcript={TRANSCRIPT} card />)
    expect(document.activeElement).toBe(findInput())
    press(findInput()!, 'Escape')
    expect(document.activeElement).toBe(screen.getByTestId('card'))
  })
})
