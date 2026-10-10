// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useRef, useState, type ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { KeybindingOverrides } from '../../../../shared/keybindings'
import { dispatchAppMenuPasteEvent } from '@/lib/app-menu-paste'
import { findOwnedTextControlPasteTarget } from '@/lib/text-control-paste-ownership'
import { isMacPlatform } from './native-chat-shortcut'
import { NativeChatFindBar } from './NativeChatFindBar'
import { useNativeChatFind } from './use-native-chat-find'
import { useNativeChatPasteBridge } from './use-native-chat-paste-bridge'
import { routeNativeChatRootKeyToInput } from './native-chat-root-key-routing'
import { shouldFocusNativeChatPaneFromPointerTarget } from './native-chat-typing-redirect'
import { useNativeChatComposerKeyDown } from './use-native-chat-composer-keydown'
import { useNativeChatPromptCardFocus } from './use-native-chat-prompt-card-focus'
import type { NativeChatComposerHandle } from './NativeChatComposer'

const mocks = vi.hoisted(() => {
  const bindings: { current?: KeybindingOverrides } = {}
  return { bindings, web: false }
})
vi.mock('../../store', () => ({
  useAppStore: { getState: () => ({ keybindings: mocks.bindings.current }) }
}))
vi.mock('@/lib/web-client-location', () => ({ isWebClientLocation: () => mocks.web }))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

/** `element` is the rendered composer field, set when it mounts. */
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
    insertTypedText: vi.fn(() => true),
    appendText: vi.fn(),
    acceptsText: () => true,
    handlePasteEvent: vi.fn(),
    pasteFromClipboard: vi.fn(),
    contains: (node) => handle.element.contains(node)
  }
  return handle
}

/** The real composer key handling, wired as the composer field wires it (onKeyDownCapture). */
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
}

function PromptCard(): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  useNativeChatPromptCardFocus(ref, true)
  return <div ref={ref} data-testid="card" tabIndex={-1} data-native-chat-prompt-card-focus />
}

/** Mirrors a chat root: pointer focus, root key routing, the find bar over the transcript. */
function Chat({
  composer,
  transcript,
  enabled = true,
  reveal = vi.fn(),
  interrupt = vi.fn(),
  suggestionsOpen = false,
  card = false
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
      {card ? <PromptCard /> : null}
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

/** The focused find input when two chats have one open, else the only one. */
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

async function nextFrame(): Promise<void> {
  await act(async () => {
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  })
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
  it('opens from the composer and counts only what the transcript shows', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    composer.element.textContent = 'alpha in the draft'
    composer.element.focus()

    expect(pressModF(composer.element).defaultPrevented).toBe(true)
    expect(document.activeElement).toBe(findInput())

    typeQuery('ALPHA')
    expect(status()).toBe('1/2')
    typeQuery('nothing here')
    expect(status()).toBe('No results')
  })

  it('leaves Mod+F alone outside the chat and while the chat is not focused', () => {
    const composer = composerHandle()
    const outside = document.createElement('input')
    document.body.append(outside)
    const view = render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    expect(pressModF(outside).defaultPrevented).toBe(false)

    view.rerender(<Chat composer={composer} transcript={TRANSCRIPT} enabled={false} />)
    expect(pressModF(composer.element).defaultPrevented).toBe(false)
    expect(findInput()).toBeNull()
  })

  it('steps with Enter and Shift+Enter, revealing each match through the transcript', () => {
    const reveal = vi.fn()
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} reveal={reveal} />)
    pressModF(composer.element)
    typeQuery('alpha')
    reveal.mockClear()

    press(findInput()!, 'Enter')
    expect(status()).toBe('2/2')
    expect(reveal).toHaveBeenLastCalledWith(expect.any(Range), expect.any(DOMRect))
    expect(reveal.mock.lastCall?.[0].toString()).toBe('alpha')
    press(findInput()!, 'Enter', { shiftKey: true })
    expect(status()).toBe('1/2')
    press(findInput()!, 'Enter', { shiftKey: true })
    expect(status()).toBe('2/2')
    expect(reveal).toHaveBeenCalledTimes(3)
  })

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

  it('Escape in the bar closes it and returns focus to where find was opened from', () => {
    const composer = composerHandle()
    render(
      <Chat
        composer={composer}
        transcript={
          <button type="button" data-testid="row-action">
            alpha
          </button>
        }
      />
    )
    const rowAction = screen.getByTestId('row-action')
    rowAction.focus()
    pressModF(rowAction)
    expect(press(findInput()!, 'Escape').defaultPrevented).toBe(true)
    expect(findInput()).toBeNull()
    expect(document.activeElement).toBe(rowAction)
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

  it('re-searches when the transcript changes, keeping the active match', async () => {
    function Streaming({ composer }: { composer: Composer }): React.JSX.Element {
      const [rows, setRows] = useState(['alpha one', 'alpha two'])
      return (
        <>
          <button type="button" onClick={() => setRows((r) => [...r, 'alpha three'])}>
            append
          </button>
          <button type="button" onClick={() => setRows((r) => ['alpha zero', ...r])}>
            prepend
          </button>
          <Chat
            composer={composer}
            transcript={rows.map((row) => (
              <p key={row}>{row}</p>
            ))}
          />
        </>
      )
    }
    const composer = composerHandle()
    render(<Streaming composer={composer} />)
    pressModF(composer.element)
    typeQuery('alpha')
    press(findInput()!, 'Enter')
    expect(status()).toBe('2/2')

    fireEvent.click(screen.getByRole('button', { name: 'append' }))
    await nextFrame()
    expect(status()).toBe('2/3')

    fireEvent.click(screen.getByRole('button', { name: 'prepend' }))
    await nextFrame()
    expect(status()).toBe('3/4')
  })

  it('paints into a shared registry as a union with another open find, and clears on close', () => {
    class StubHighlight {
      readonly ranges = new Set<Range>()
      add(range: Range): void {
        this.ranges.add(range)
      }
    }
    const registry = new Map<string, StubHighlight>()
    vi.stubGlobal('Highlight', StubHighlight)
    vi.stubGlobal('CSS', { highlights: registry })
    const first = composerHandle()
    const second = composerHandle()
    render(
      <>
        <Chat composer={first} transcript={<p>alpha alpha</p>} />
        <Chat composer={second} transcript={<p>alpha</p>} />
      </>
    )
    pressModF(first.element)
    typeQuery('alpha')
    pressModF(second.element)
    typeQuery('alpha')
    expect(registry.get('native-chat-find-match')?.ranges.size).toBe(3)
    expect(registry.get('native-chat-find-active-match')?.ranges.size).toBe(2)

    press(findInput()!, 'Escape')
    expect(registry.get('native-chat-find-match')?.ranges.size).toBe(2)
    press(findInput()!, 'Escape')
    expect(registry.has('native-chat-find-match')).toBe(false)
    expect(registry.has('native-chat-find-active-match')).toBe(false)
  })

  it('keeps paste, typing and editing keys in the find input', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    const input = findInput()!

    // Unclaimed by the chat, the app-menu paste goes to the focused text control: the find input.
    expect(dispatchAppMenuPasteEvent()).toBe(false)
    expect(composer.pasteFromClipboard).not.toHaveBeenCalled()
    expect(findOwnedTextControlPasteTarget(document.activeElement)).toBe(input)

    for (const key of ['a', 'Backspace', 'v']) {
      const event = new KeyboardEvent('keydown', {
        key,
        bubbles: true,
        cancelable: true,
        metaKey: key === 'v' && isMacPlatform(),
        ctrlKey: key === 'v' && !isMacPlatform()
      })
      Object.defineProperty(event, 'target', { value: input })
      routeNativeChatRootKeyToInput(event, composer, null)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(composer.insertTypedText).not.toHaveBeenCalled()
    expect(composer.focus).not.toHaveBeenCalled()
  })
  it('keeps the find input focused when a prompt card arrives mid-query', () => {
    const composer = composerHandle()
    const view = render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    const input = findInput()
    view.rerender(<Chat composer={composer} transcript={TRANSCRIPT} card />)
    expect(document.activeElement).toBe(input)
  })

  it('keeps typing in the find input after a press on the count or padding', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    typeQuery('alpha')
    const input = findInput()!
    const count = input.parentElement!.querySelector('[aria-live]')!
    fireEvent.pointerDown(count, { button: 0 })
    expect(fireEvent.mouseDown(count, { button: 0 })).toBe(false)
    expect(document.activeElement).toBe(input)
    press(document.activeElement!, 'x')
    expect(composer.insertTypedText).not.toHaveBeenCalled()
  })

  it('steps only on Enter from the input; the buttons keep their own Enter', () => {
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    pressModF(composer.element)
    typeQuery('alpha')
    for (const name of ['Previous match', 'Close']) {
      const button = screen.getByRole('button', { name })
      button.focus()
      expect(press(button, 'Enter').defaultPrevented).toBe(false)
      expect(status()).toBe('1/2')
    }
  })

  it('starts from the first visible match when the active match scrolled out of the window', async () => {
    function Window({ rows }: { rows: string[] }): React.JSX.Element {
      return (
        <>
          {rows.map((row) => (
            <p key={row}>alpha {row}</p>
          ))}
        </>
      )
    }
    const composer = composerHandle()
    const view = render(
      <Chat composer={composer} transcript={<Window rows={['r1', 'r2', 'r3', 'r4', 'r5']} />} />
    )
    pressModF(composer.element)
    typeQuery('alpha')
    for (let step = 0; step < 3; step += 1) {
      press(findInput()!, 'Enter')
    }
    expect(status()).toBe('4/5')
    view.rerender(
      <Chat
        composer={composer}
        transcript={<Window rows={['p1', 'p2', 'p3', 'p4', 'r1', 'r2']} />}
      />
    )
    await nextFrame()
    // Not "4/6": that index now points at an unrelated row.
    expect(status()).toBe('1/6')
  })

  it('re-searches growing text that holds a match before the next paint, other text later', async () => {
    const composer = composerHandle()
    render(
      <Chat
        composer={composer}
        transcript={
          <>
            <p data-testid="quiet">beta</p>
            <p data-testid="streaming">alpha</p>
          </>
        }
      />
    )
    pressModF(composer.element)
    typeQuery('alpha')
    expect(status()).toBe('1/1')
    const textOf = (id: string): Text => {
      const text = screen.getByTestId(id).firstChild
      if (!(text instanceof Text)) {
        throw new Error(`no text node in ${id}`)
      }
      return text
    }
    // React rewrites a growing node whole, collapsing its ranges: repaint them this frame.
    textOf('streaming').data = 'alpha alpha'
    await nextFrame()
    expect(status()).toBe('1/2')
    // Growth with no match in it waits for the short timer.
    textOf('quiet').data = 'beta alpha'
    await nextFrame()
    expect(status()).toBe('1/2')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    // The new match sits above the active one, which stays active.
    expect(status()).toBe('2/3')
  })

  it('matches across the words of a reply that is still fading in', () => {
    const composer = composerHandle()
    render(
      <Chat
        composer={composer}
        transcript={
          <p>
            <span data-word-group="">
              The <span data-word="">quick</span> <span data-word="">brown</span>
            </span>
          </p>
        }
      />
    )
    pressModF(composer.element)
    typeQuery('the quick brown')
    expect(status()).toBe('1/1')
  })

  it('waits on words drawn into a reply; a settling word that held a match repaints at once', async () => {
    const composer = composerHandle()
    render(
      <Chat
        composer={composer}
        transcript={
          <>
            <p>
              <span data-word-group="" data-testid="streaming">
                settled <span data-word="">alpha</span>
              </span>
            </p>
            <p>
              <span data-word-group="" data-testid="quiet">
                beta
              </span>
            </p>
          </>
        }
      />
    )
    pressModF(composer.element)
    typeQuery('alpha')
    expect(status()).toBe('1/1')
    const searches = vi.spyOn(document, 'createTreeWalker')
    // A word drawn each frame with no match near it waits for the short timer.
    const word = document.createElement('span')
    word.dataset.word = ''
    word.textContent = 'alpha'
    screen.getByTestId('quiet').append(' ', word)
    await nextFrame()
    expect(searches).not.toHaveBeenCalled()
    expect(status()).toBe('1/1')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 200))
    })
    expect(status()).toBe('1/2')

    // The word holding the active match settles into the plain text before it: its range is gone.
    searches.mockClear()
    const streaming = screen.getByTestId('streaming')
    const prefix = streaming.firstChild
    if (!(prefix instanceof Text)) {
      throw new Error('no settled text')
    }
    streaming.querySelector('[data-word]')?.remove()
    prefix.data = 'settled alpha'
    await nextFrame()
    expect(searches).toHaveBeenCalled()
    expect(status()).toBe('1/2')
  })

  it('counts an opening disclosure once its height animation ends', async () => {
    const composer = composerHandle()
    const { container } = render(
      <Chat
        composer={composer}
        transcript={
          <div data-testid="disclosure" style={{ overflow: 'hidden' }}>
            <p>alpha in the output</p>
          </div>
        }
      />
    )
    const place = (element: Element, y: number, height: number): void => {
      Object.defineProperty(element, 'getBoundingClientRect', {
        configurable: true,
        value: () => DOMRect.fromRect({ x: 0, y, width: 600, height })
      })
    }
    place(container.querySelector('[data-native-chat-scroll]')!, 0, 600)
    const disclosure = screen.getByTestId('disclosure')
    place(disclosure, 0, 0)
    Object.defineProperty(disclosure, 'scrollHeight', { configurable: true, value: 200 })
    Object.defineProperty(disclosure, 'clientHeight', { configurable: true, value: 0 })
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockReturnValue(
      DOMRect.fromRect({ x: 20, y: 10, width: 40, height: 18 })
    )
    pressModF(composer.element)
    typeQuery('alpha')
    // First frame of the animation: the box is still 0 px tall.
    expect(status()).toBe('No results')

    place(disclosure, 0, 200)
    Object.defineProperty(disclosure, 'clientHeight', { configurable: true, value: 200 })
    act(() => {
      disclosure.dispatchEvent(new Event('animationend', { bubbles: true }))
    })
    await nextFrame()
    expect(status()).toBe('1/1')
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

  it('leaves Mod+F to the browser in the web client', () => {
    mocks.web = true
    const composer = composerHandle()
    render(<Chat composer={composer} transcript={TRANSCRIPT} />)
    expect(pressModF(composer.element).defaultPrevented).toBe(false)
    expect(findInput()).toBeNull()
  })
  it('picks the first visible match while typing without scrolling or leaving the end', () => {
    const reveal = vi.fn()
    const composer = composerHandle()
    const { container } = render(
      <Chat composer={composer} transcript={TRANSCRIPT} reveal={reveal} />
    )
    const scroller = container.querySelector('[data-native-chat-scroll]')!
    Object.defineProperty(scroller, 'getBoundingClientRect', {
      value: () => DOMRect.fromRect({ x: 0, y: 100, width: 800, height: 600 })
    })
    // The first match sits above the view; the second in the top band, left of the bar.
    vi.spyOn(Range.prototype, 'getBoundingClientRect').mockImplementation(function (this: Range) {
      const above = this.startContainer.textContent === 'alpha one'
      return DOMRect.fromRect({ x: 20, y: above ? -200 : 110, width: 40, height: 18 })
    })
    pressModF(composer.element)
    typeQuery('alpha')
    expect(status()).toBe('2/2')
    expect(reveal).not.toHaveBeenCalled()
  })
})
