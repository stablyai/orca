import type { PreviewTerminalLinkHandler } from './preview-terminal-links'
import { vi, type Mock } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { TerminalKittyKeyboardModeTracker } from '../../../../shared/terminal-kitty-keyboard-mode-tracker'
import {
  openStandaloneTerminal,
  type StandaloneTerminal
} from '../standalone-terminal/open-standalone-terminal'
import { installDashboardPreviewLinkInteraction } from './dashboard-preview-link-interaction'
import type { DashboardPreviewLinkSource } from './dashboard-preview-http-actions'

/** Model the browser layout boundary; xterm still measures, renders and hit-tests its own cells. */
export function installPreviewDomFixture(): () => void {
  const style = document.createElement('style')
  style.textContent = '.xterm, .xterm-screen { padding: 0px; }'
  document.head.appendChild(style)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => {
    const context: CanvasRenderingContext2D = Object.create(null)
    context.font = '13px monospace'
    context.measureText = (text) => Object.assign(Object.create(null), { width: text.length * 10 })
    context.clearRect = vi.fn()
    context.fillRect = vi.fn()
    return context
  })
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    return new DOMRect(0, 0, this.offsetWidth, this.offsetHeight)
  })
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('xterm-char-measure-element')
      ? 320
      : Number.parseFloat(this.style.width) || 800
  })
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(function (
    this: HTMLElement
  ) {
    return this.classList.contains('xterm-char-measure-element')
      ? 20
      : Number.parseFloat(this.style.height) || 160
  })
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(800)
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(160)
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  )
  return () => style.remove()
}

export function observePreviewListeners(elements: HTMLElement[]) {
  type Registration = {
    target: EventTarget
    type: string
    listener: EventListenerOrEventListenerObject
    capture: boolean
    wrapped: EventListener
  }
  const active = new Set<Registration>()
  let callbacks = 0
  const spies = [document, window, ...elements].flatMap((target) => {
    const nativeAdd: EventTarget['addEventListener'] = target.addEventListener
    const nativeRemove: EventTarget['removeEventListener'] = target.removeEventListener
    const add = vi.spyOn(target, 'addEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions
    ) {
      if (!listener) {
        return
      }
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
      if (
        Array.from(active).some(
          (r) =>
            r.target === this && r.type === type && r.listener === listener && r.capture === capture
        )
      ) {
        return
      }
      const wrapped: EventListener = function (this: EventTarget, event) {
        if (this === document || this === window) {
          callbacks++
        }
        if (typeof listener === 'function') {
          listener.call(this, event)
        } else {
          listener.handleEvent(event)
        }
      }
      active.add({ target: this, type, listener, capture, wrapped })
      nativeAdd.call(this, type, wrapped, options)
    })
    const remove = vi.spyOn(target, 'removeEventListener').mockImplementation(function (
      this: EventTarget,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | EventListenerOptions
    ) {
      const capture = typeof options === 'boolean' ? options : Boolean(options?.capture)
      const registration = Array.from(active).find(
        (r) =>
          r.target === this && r.type === type && r.listener === listener && r.capture === capture
      )
      if (registration) {
        nativeRemove.call(this, type, registration.wrapped, options)
        active.delete(registration)
      } else {
        nativeRemove.call(this, type, listener, options)
      }
    })
    return [add, remove]
  })
  return {
    active,
    get callbacks() {
      return callbacks
    },
    resetCallbacks: () => {
      callbacks = 0
    },
    restore: () => {
      for (const spy of spies) {
        spy.mockRestore()
      }
    }
  }
}

export function mountPreviewLinkInteraction(
  source: DashboardPreviewLinkSource,
  readSettings: () => GlobalSettings | null,
  trackInstance: (instance: ReturnType<typeof openStandaloneTerminal>) => void,
  withInteraction = true
): {
  instance: StandaloneTerminal
  install: () => ReturnType<typeof installDashboardPreviewLinkInteraction>
  sink: Mock<(data: string) => boolean | Promise<boolean>>
  getSource: Mock<() => DashboardPreviewLinkSource | undefined>
  getSettings: Mock<() => GlobalSettings | null>
  request: Mock<Parameters<typeof installDashboardPreviewLinkInteraction>[1]['request']>
  container: HTMLDivElement
} {
  const container = document.createElement('div')
  document.body.appendChild(container)
  let interaction: ReturnType<typeof installDashboardPreviewLinkInteraction> | undefined
  let defaultHandlers: PreviewTerminalLinkHandler | undefined
  const sink = vi.fn<(data: string) => boolean | Promise<boolean>>(() => true)
  const instance = openStandaloneTerminal({
    container,
    options: { cols: 80, rows: 8, allowProposedApi: true },
    kittyKeyboardModes: new TerminalKittyKeyboardModeTracker({ kittyKeyboard: true }),
    sessionKey: source.ptyId,
    sendInput: (data) => (interaction ? interaction.sendInput(data) : sink(data)),
    answersQueries: false,
    getSettings: readSettings,
    getMacOptionAsAlt: () => 'false',
    getTerminalInput: () => null,
    ...(withInteraction
      ? {
          linkHandlers: (defaults: PreviewTerminalLinkHandler): PreviewTerminalLinkHandler => {
            defaultHandlers = defaults
            return {
              activate: (e, uri, range) => interaction?.handlers.activate(e, uri, range),
              hover: (e, uri, range) => interaction?.handlers.hover?.(e, uri, range),
              leave: (e, uri, range) => interaction?.handlers.leave?.(e, uri, range)
            }
          }
        }
      : {})
  })
  if (!instance) {
    throw new Error('Actual standalone constructor failed')
  }
  const request = vi.fn<Parameters<typeof installDashboardPreviewLinkInteraction>[1]['request']>()
  const getSource = vi.fn<() => DashboardPreviewLinkSource | undefined>(() => source)
  const getSettings = vi.fn(readSettings)
  const install = () => {
    interaction = installDashboardPreviewLinkInteraction(instance.terminal, {
      getSource,
      getSettings,
      defaultHandlers,
      onForegroundOpen: () => undefined,
      request,
      sendInput: sink
    })
    return interaction
  }
  const dispose = () => {
    interaction?.dispose()
    instance.dispose()
    container.remove()
  }
  trackInstance({ ...instance, dispose })
  return { instance, install, sink, getSource, getSettings, request, container }
}
