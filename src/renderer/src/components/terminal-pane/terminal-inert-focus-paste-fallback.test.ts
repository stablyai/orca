// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest'

import {
  installInertFocusPasteFallback,
  restoreInertFocusPasteTarget
} from './terminal-inert-focus-paste-fallback'

// STA-5272 / STA-3834: a dictation tool, IME, or overlay hands focus back to <body>,
// not to the pane. The pane's own keydown/paste listeners are bound to its root
// container with capture, so a body-targeted chord never reaches them: no paste,
// no error, nothing. Everything here runs on real DOM nodes and real dispatched
// events — a `contains` double would let this pass against unreachable state.
describe('inert-focus paste fallback', () => {
  let container: HTMLElement
  let inside: HTMLTextAreaElement
  let outside: HTMLInputElement
  let onPasteKey: Mock<(event: KeyboardEvent) => void>
  let onPasteEvent: Mock<(event: ClipboardEvent) => void>
  let dispose: (() => void) | null

  const install = (): ReturnType<typeof installInertFocusPasteFallback> => {
    const fallback = installInertFocusPasteFallback({ container, onPasteKey, onPasteEvent })
    dispose = fallback.dispose
    return fallback
  }
  const pressPasteChordOn = (target: EventTarget): void => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    )
  }

  beforeEach(() => {
    document.body.innerHTML = ''
    container = document.createElement('div')
    inside = document.createElement('textarea')
    inside.className = 'xterm-helper-textarea'
    container.append(inside)
    outside = document.createElement('input')
    document.body.append(container, outside)
    onPasteKey = vi.fn()
    onPasteEvent = vi.fn()
    dispose = null
  })

  afterEach(() => {
    dispose?.()
    document.body.innerHTML = ''
  })

  it('premise: a container-bound capture listener never sees a body-targeted chord', () => {
    const paneListener = vi.fn()
    container.addEventListener('keydown', paneListener, { capture: true })
    inside.focus()
    inside.blur()

    pressPasteChordOn(document.body)

    // This is the whole defect: body is the container's ancestor, so the capture
    // path document -> html -> body never reaches the container.
    expect(paneListener).not.toHaveBeenCalled()
    container.removeEventListener('keydown', paneListener, { capture: true })
  })

  it('recovers a paste chord that lands on body after the pane blurred to it', () => {
    install()
    inside.focus()
    inside.blur()

    expect(document.activeElement).toBe(document.body)
    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  it('recovers a native paste event that lands on body the same way', () => {
    install()
    inside.focus()
    inside.blur()

    document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))

    expect(onPasteEvent).toHaveBeenCalledTimes(1)
  })

  it('leaves events inside the pane to the pane so a paste cannot fire twice', () => {
    install()
    inside.focus()

    pressPasteChordOn(inside)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('leaves an in-pane event to the pane even while focus itself is inert', () => {
    install()
    inside.focus()
    inside.blur()
    expect(document.activeElement).toBe(document.body)

    // A programmatic paste aimed at a pane child while focus sits on body: the
    // pane's own capture listener does receive this one, so the fallback must not
    // handle it as well and paste twice.
    inside.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))
    pressPasteChordOn(inside)

    expect(onPasteEvent).not.toHaveBeenCalled()
    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('does not steal a paste once another surface has taken focus', () => {
    install()
    inside.focus()
    outside.focus()
    // Focus then falls to body from that other surface, not from the pane.
    outside.blur()

    expect(document.activeElement).toBe(document.body)
    pressPasteChordOn(document.body)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('does not steal a paste after the user clicks outside the pane', () => {
    install()
    inside.focus()
    inside.blur()
    // A click on a non-focusable region blurs to body with no focusin at all, so
    // the pointer is the only evidence the user moved on.
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))

    pressPasteChordOn(document.body)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('keeps ownership through a click inside the pane', () => {
    install()
    inside.focus()
    inside.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    inside.blur()

    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  it('does not fire while a real element outside the pane holds focus', () => {
    install()
    inside.focus()
    outside.focus()

    expect(document.activeElement).toBe(outside)
    pressPasteChordOn(outside)

    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('claims focus that already sat in the pane when the listeners were installed', () => {
    inside.focus()
    install()
    inside.blur()

    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  it('reports inert-focus ownership so other paste entry points can share the test', () => {
    const fallback = install()

    expect(fallback.ownsInertFocus()).toBe(false)
    inside.focus()
    expect(fallback.ownsInertFocus()).toBe(false)
    inside.blur()
    expect(fallback.ownsInertFocus()).toBe(true)
    outside.focus()
    expect(fallback.ownsInertFocus()).toBe(false)
  })

  // STA-5272 review: the pane can stop being rendered while `isActive` stays
  // true (a CSS-hidden floating panel, a display:none background surface). The
  // browser blurs its focus to <body> WITHOUT a focusin, so `paneOwnsFocus`
  // stays stale. These listeners sit at the document in capture phase, so a
  // stale claim swallows the chord (preventDefault + stopPropagation) for the
  // whole app and routes the paste into an invisible terminal.
  it('does not claim inert focus once the pane is no longer rendered', () => {
    const fallback = install()
    inside.focus()
    inside.blur()
    expect(fallback.ownsInertFocus()).toBe(true)

    // Exactly how the closed floating terminal panel hides its subtree.
    container.style.visibility = 'hidden'

    expect(fallback.ownsInertFocus()).toBe(false)
  })

  it('does not swallow the paste chord for the rest of the app while hidden', () => {
    install()
    inside.focus()
    inside.blur()
    container.style.visibility = 'hidden'

    pressPasteChordOn(document.body)
    document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))

    expect(onPasteKey).not.toHaveBeenCalled()
    expect(onPasteEvent).not.toHaveBeenCalled()
  })

  it('does not claim inert focus after its container leaves the document', () => {
    const fallback = install()
    inside.focus()
    inside.blur()
    container.remove()

    expect(fallback.ownsInertFocus()).toBe(false)
    pressPasteChordOn(document.body)
    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('honours the browser visibility check that covers display:none subtrees', () => {
    // happy-dom has no checkVisibility; production Chromium does, and it is the
    // only check that sees a display:none ancestor. Pin that we call it.
    const calls: unknown[] = []
    ;(container as HTMLElement & { checkVisibility?: (o?: unknown) => boolean }).checkVisibility = (
      options
    ) => {
      calls.push(options)
      return false
    }
    const fallback = install()
    inside.focus()
    inside.blur()

    expect(fallback.ownsInertFocus()).toBe(false)
    expect(calls.length).toBeGreaterThan(0)
    pressPasteChordOn(document.body)
    expect(onPasteKey).not.toHaveBeenCalled()
  })

  it('still recovers when the browser reports the container as visible', () => {
    ;(container as HTMLElement & { checkVisibility?: (o?: unknown) => boolean }).checkVisibility =
      () => true
    install()
    inside.focus()
    inside.blur()

    pressPasteChordOn(document.body)

    expect(onPasteKey).toHaveBeenCalledTimes(1)
  })

  // Coordinator finding, verified here at the fallback level: with several panes
  // mounted, a pane that lost focus only because it was HIDDEN must not claim the
  // chord. Real Tailwind `hidden` is display:none on a WRAPPER, and computed
  // `display` does not cascade to descendants in either engine, so the check has
  // to walk ancestors — reading `visibility` off the container alone fails OPEN.
  it('does not claim inert focus when an ancestor wrapper is display:none', () => {
    const wrapper = document.createElement('div')
    document.body.append(wrapper)
    wrapper.append(container)
    const fallback = install()
    inside.focus()
    inside.blur()
    expect(fallback.ownsInertFocus()).toBe(true)

    // Exactly what Terminal.tsx does to a hidden worktree: `absolute inset-0 hidden`.
    wrapper.style.display = 'none'

    expect(fallback.ownsInertFocus()).toBe(false)
    pressPasteChordOn(document.body)
    expect(onPasteKey).not.toHaveBeenCalled()
  })

  // The defensive path has to fail CLOSED. A missed recovery is a dropped chord —
  // the pre-PR behaviour, and the user can click and retry. A false claim pastes
  // into an invisible terminal and consumes the chord app-wide, which they cannot
  // undo. So an engine that can tell us nothing must not be read as "rendered".
  it('refuses to claim when the container has no view to ask about visibility', () => {
    const foreign = document.implementation.createHTMLDocument('detached')
    const foreignContainer = foreign.createElement('div')
    const foreignInside = foreign.createElement('textarea')
    foreignContainer.append(foreignInside)
    foreign.body.append(foreignContainer)
    expect(foreignContainer.isConnected).toBe(true)
    expect(foreignContainer.ownerDocument.defaultView).toBe(null)

    // Claim ownership at install time, the path the pane itself takes on remount.
    foreignInside.focus()
    expect(foreign.activeElement).toBe(foreignInside)
    const recovered: KeyboardEvent[] = []
    const fallback = installInertFocusPasteFallback({
      container: foreignContainer,
      documentTarget: foreign,
      onPasteKey: (event) => recovered.push(event),
      onPasteEvent: () => {}
    })
    foreignInside.blur()
    expect(foreign.activeElement).toBe(foreign.body)

    expect(fallback.ownsInertFocus()).toBe(false)
    expect(recovered).toEqual([])
    fallback.dispose()
  })

  it('stops recovering pastes after dispose', () => {
    const fallback = install()
    inside.focus()
    inside.blur()
    fallback.dispose()
    dispose = null

    pressPasteChordOn(document.body)
    document.body.dispatchEvent(new Event('paste', { bubbles: true, cancelable: true }))

    expect(onPasteKey).not.toHaveBeenCalled()
    expect(onPasteEvent).not.toHaveBeenCalled()
  })
})

// Coordinator finding on #17020: `TerminalPane` is not a singleton, so several
// fallbacks are installed at the document at once. Two questions follow — can a
// hidden instance capture a chord aimed elsewhere, and can two instances both act
// on the same event? Real DOM and real dispatched events throughout.
describe('inert-focus paste fallback with several panes mounted', () => {
  type Scene = {
    panes: { container: HTMLElement; inside: HTMLTextAreaElement; keys: KeyboardEvent[] }[]
    dispose: () => void
  }

  const buildScene = (count: number): Scene => {
    document.body.innerHTML = ''
    const disposers: (() => void)[] = []
    const panes = Array.from({ length: count }, () => {
      const wrapper = document.createElement('div')
      const paneContainer = document.createElement('div')
      const helper = document.createElement('textarea')
      helper.className = 'xterm-helper-textarea'
      paneContainer.append(helper)
      wrapper.append(paneContainer)
      document.body.append(wrapper)
      const keys: KeyboardEvent[] = []
      const fallback = installInertFocusPasteFallback({
        container: paneContainer,
        onPasteKey: (event) => keys.push(event),
        onPasteEvent: () => {}
      })
      disposers.push(fallback.dispose)
      return { container: paneContainer, inside: helper, keys }
    })
    return { panes, dispose: () => disposers.forEach((d) => d()) }
  }

  const chord = (): void => {
    document.body.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'v', ctrlKey: true, bubbles: true, cancelable: true })
    )
  }

  it('lets a hidden background pane capture nothing after a focus-less switch away', () => {
    // The reported chain: pane A holds focus, the user switches by KEYBOARD (no
    // pointerdown), A's wrapper is hidden so the browser blurs it to <body> with
    // NO focusin, and the destination surface takes no focus of its own.
    const scene = buildScene(3)
    scene.panes[0]!.inside.focus()
    ;(scene.panes[0]!.container.parentElement as HTMLElement).style.display = 'none'
    expect(document.activeElement).toBe(scene.panes[0]!.inside)
    // happy-dom does not blur on hide, so blur explicitly: the browser's behaviour
    // is the premise, not the thing under test.
    scene.panes[0]!.inside.blur()
    expect(document.activeElement).toBe(document.body)

    chord()

    expect(scene.panes.map((pane) => pane.keys.length)).toEqual([0, 0, 0])
    scene.dispose()
  })

  it('never lets two panes act on the same chord', () => {
    const scene = buildScene(3)
    scene.panes[0]!.inside.focus()
    // A real focus move to another pane, which every instance sees at the document.
    scene.panes[1]!.inside.focus()
    scene.panes[1]!.inside.blur()

    chord()

    expect(scene.panes.map((pane) => pane.keys.length)).toEqual([0, 1, 0])
    scene.dispose()
  })

  it('leaves the chord to the app when no pane ever held focus', () => {
    const scene = buildScene(3)
    const elsewhere = document.createElement('input')
    document.body.append(elsewhere)
    elsewhere.focus()
    elsewhere.blur()

    chord()

    expect(scene.panes.map((pane) => pane.keys.length)).toEqual([0, 0, 0])
    scene.dispose()
  })
})

describe('restoreInertFocusPasteTarget', () => {
  const buildPane = (): { container: HTMLElement; terminal: { focus: Mock<() => void> } } => {
    document.body.innerHTML = ''
    const container = document.createElement('div')
    const helper = document.createElement('textarea')
    helper.className = 'xterm-helper-textarea'
    container.append(helper)
    document.body.append(container)
    return { container, terminal: { focus: vi.fn<() => void>() } }
  }

  it('puts focus back on the pane when focus fell to body', () => {
    const pane = buildPane()

    restoreInertFocusPasteTarget(pane, document.body)

    expect(pane.terminal.focus).toHaveBeenCalledTimes(1)
  })

  it('puts focus back on the pane when nothing at all has focus', () => {
    const pane = buildPane()

    restoreInertFocusPasteTarget(pane, null)

    expect(pane.terminal.focus).toHaveBeenCalledTimes(1)
  })

  it('leaves focus alone when it is already inside the pane', () => {
    const pane = buildPane()

    restoreInertFocusPasteTarget(pane, pane.container.firstElementChild as Element)

    expect(pane.terminal.focus).not.toHaveBeenCalled()
  })
})
