import { Window } from 'happy-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE,
  buildNativeChatVisualDocument
} from './native-chat-visual-shell'

const theme = { colorScheme: 'light' as const, tokens: {} }

type ShellElement = NonNullable<ReturnType<Window['document']['getElementById']>>

type Shell = {
  sent: unknown[]
  window: Window
  byId: (id: string) => ShellElement
  root: ShellElement
  wheel: (
    target: ShellElement,
    deltaY: number,
    init?: { ctrlKey?: boolean; cancelable?: boolean }
  ) => void
}

/** Runs the shell's bootstrap in a window of its own, with the host being that same window. */
function bootShell(html: string): Shell {
  const shellWindow = new Window()
  const { document } = shellWindow
  document.body.innerHTML = html.replace(/^<body>|<\/body>$/g, '')
  const built = buildNativeChatVisualDocument({ html, channel: 'c', theme })
  const script = built.slice(
    built.indexOf('<script>') + '<script>'.length,
    built.indexOf('</script>')
  )
  const sent: unknown[] = []
  shellWindow.postMessage = (message: unknown) => {
    if (
      typeof message === 'object' &&
      message !== null &&
      'type' in message &&
      message.type === NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE
    ) {
      sent.push(message)
    }
  }
  new Function('window', 'document', 'getComputedStyle', script)(
    shellWindow,
    document,
    shellWindow.getComputedStyle.bind(shellWindow)
  )
  return {
    sent,
    window: shellWindow,
    byId: (id) => {
      const element = document.getElementById(id)
      if (!element) {
        throw new Error(`no #${id}`)
      }
      return element
    },
    root: document.documentElement,
    wheel: (target, deltaY, init = {}) => {
      const event = new shellWindow.WheelEvent('wheel', {
        bubbles: true,
        composed: true,
        deltaY,
        ...init
      })
      // happy-dom's WheelEvent drops the modifier from its init.
      Object.defineProperty(event, 'ctrlKey', { value: init.ctrlKey === true })
      target.dispatchEvent(event)
      // The report waits for the dispatch to finish.
      vi.runAllTimers()
    }
  }
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.useRealTimers()
})

describe('visual shell reader scroll', () => {
  it('reports uncancelled input even when a nested scroller can take it', () => {
    const shell = bootShell(
      '<body><div id="box" style="overflow-y:auto;overscroll-behavior-y:contain"><p id="text">chart</p></div></body>'
    )
    shell.wheel(shell.byId('text'), -10)
    expect(shell.sent).toEqual([
      { type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE, channel: 'c', input: 'wheel', deltaY: -10 }
    ])
  })

  it('leaves a wheel the visual cancelled with the visual, wherever it cancels it', () => {
    const shell = bootShell('<body><div id="chart">chart</div></body>')
    const chart = shell.byId('chart')
    const cancel = (event: { preventDefault: () => void }): void => event.preventDefault()
    chart.addEventListener('wheel', cancel)
    shell.wheel(chart, -10, { cancelable: true })
    expect(shell.sent, 'cancelled on the chart').toEqual([])
    chart.removeEventListener('wheel', cancel)
    shell.wheel(chart, -10, { cancelable: true })
    expect(shell.sent, 'not cancelled').toHaveLength(1)
    // A handler the visual installs on the window runs after the shell's own.
    shell.window.addEventListener('wheel', cancel)
    shell.wheel(chart, -10, { cancelable: true })
    expect(shell.sent, 'cancelled at the window').toHaveLength(1)
  })

  it('still hears a wheel a handler stopped from bubbling, since the transcript still scrolls', () => {
    const shell = bootShell('<body><div id="chart">chart</div></body>')
    shell.byId('chart').addEventListener('wheel', (event) => event.stopPropagation())
    shell.wheel(shell.byId('chart'), -10)
    expect(shell.sent).toHaveLength(1)
  })

  it('keeps a zoom wheel and a still wheel to the page', () => {
    const shell = bootShell('<body><p id="text">chart</p></body>')
    shell.wheel(shell.byId('text'), -10, { ctrlKey: true })
    shell.wheel(shell.byId('text'), 0)
    expect(shell.sent).toEqual([])
    shell.wheel(shell.byId('text'), -10)
    expect(shell.sent, 'the same page reports a plain wheel').toHaveLength(1)
  })

  it('reports a touch drag as it moves, even one a handler stopped from bubbling', () => {
    const shell = bootShell('<body><p id="text">chart</p></body>')
    const text = shell.byId('text')
    text.dispatchEvent(new shell.window.Event('touchmove', { bubbles: true }))
    expect(shell.sent).toEqual([
      { type: NATIVE_CHAT_VISUAL_READER_SCROLL_TYPE, channel: 'c', input: 'touch' }
    ])
    text.addEventListener('touchmove', (event) => event.stopPropagation())
    text.dispatchEvent(new shell.window.Event('touchmove', { bubbles: true }))
    expect(shell.sent).toHaveLength(2)
  })
})
