import type { Page } from '@stablyai/playwright-test'

/**
 * Renderer-side listeners for the #12871 captures. Four positions plus focus ownership, so a
 * release that never reaches the renderer can be told apart from one delivered somewhere else.
 */

export function readActiveComposition(page: Page): Promise<string | null> {
  return page.evaluate(() => {
    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    const composition = textarea?.parentElement?.querySelector<HTMLElement>(
      '.composition-view.active'
    )
    return composition?.textContent?.replaceAll('‎', '') ?? null
  })
}

export async function installChordProbe(page: Page): Promise<void> {
  await page.evaluate(() => {
    type ProbeWindow = Window & { __chordKeyupProbe?: { rows: unknown[]; dispose: () => void } }
    const probeWindow = window as ProbeWindow
    probeWindow.__chordKeyupProbe?.dispose()

    const textarea = document.querySelector<HTMLTextAreaElement>('.xterm-helper-textarea:focus')
    if (!textarea) {
      throw new Error('no focused xterm helper textarea')
    }
    const rows: unknown[] = []
    const describe = (node: EventTarget | null): string | null =>
      node instanceof Element ? `${node.tagName}.${node.className}` : null

    const pushKey = (at: string, event: KeyboardEvent): void => {
      rows.push({
        at,
        t: event.type,
        key: event.key,
        code: event.code,
        keyCode: event.keyCode,
        isComposing: event.isComposing,
        meta: event.metaKey,
        alt: event.altKey,
        defaultPrevented: event.defaultPrevented,
        // Why these three: a release that never reaches the renderer and one that reaches a
        // different target look identical from a single listener.
        hasFocus: document.hasFocus(),
        activeElement: describe(document.activeElement),
        target: describe(event.target),
        textareaConnected: textarea.isConnected,
        ts: Math.round(performance.now())
      })
    }

    const positions: [string, EventTarget, boolean][] = [
      ['window-capture', window, true],
      ['document-capture', document, true],
      ['textarea-capture', textarea, true],
      ['window-bubble', window, false]
    ]
    const keyListeners: (() => void)[] = []
    for (const [name, target, capture] of positions) {
      for (const type of ['keydown', 'keyup']) {
        const listener = (event: Event): void => pushKey(name, event as KeyboardEvent)
        target.addEventListener(type, listener, capture)
        keyListeners.push(() => target.removeEventListener(type, listener, capture))
      }
    }

    // Focus loss between press and release would route the keyup out of this window entirely.
    const focusListeners: (() => void)[] = []
    for (const [name, target, type] of [
      ['window', window, 'blur'],
      ['window', window, 'focus'],
      ['textarea', textarea, 'blur'],
      ['textarea', textarea, 'focus'],
      ['document', document, 'visibilitychange']
    ] as [string, EventTarget, string][]) {
      const listener = (): void => {
        rows.push({
          at: name,
          t: type,
          hasFocus: document.hasFocus(),
          activeElement: describe(document.activeElement),
          ts: Math.round(performance.now())
        })
      }
      target.addEventListener(type, listener, true)
      focusListeners.push(() => target.removeEventListener(type, listener, true))
    }

    for (const type of ['compositionstart', 'compositionupdate', 'compositionend', 'input']) {
      const listener = (event: Event): void => {
        rows.push({
          at: 'textarea',
          t: event.type,
          data: (event as CompositionEvent).data ?? null,
          value: textarea.value,
          ts: Math.round(performance.now())
        })
      }
      textarea.addEventListener(type, listener, true)
      focusListeners.push(() => textarea.removeEventListener(type, listener, true))
    }

    probeWindow.__chordKeyupProbe = {
      rows,
      dispose: () => {
        for (const off of [...keyListeners, ...focusListeners]) {
          off()
        }
      }
    }
  })
}

export function readChordProbe(page: Page): Promise<unknown[]> {
  return page.evaluate(() => {
    const probe = (window as Window & { __chordKeyupProbe?: { rows: unknown[] } }).__chordKeyupProbe
    if (!probe) {
      throw new Error('chord probe was never installed')
    }
    return [...probe.rows]
  })
}
