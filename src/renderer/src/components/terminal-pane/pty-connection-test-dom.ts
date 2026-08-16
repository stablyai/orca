import { vi, expect } from 'vitest'
import type { MockPane } from './pty-connection-test-pane-fixtures'

export async function withMockedDocumentActiveElement<T>(
  activeElement: unknown,
  run: () => Promise<T>
): Promise<T> {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document')
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: { activeElement }
  })
  try {
    return await run()
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, 'document', originalDocument)
    } else {
      Reflect.deleteProperty(globalThis, 'document')
    }
  }
}

export function configureTerminalFocusMode(pane: MockPane, textarea: HTMLTextAreaElement): void {
  Object.assign(pane.terminal, { textarea })
  Object.assign(pane.terminal.modes, { sendFocusMode: true })
  pane.terminal.write.mockImplementation((_data: string, callback?: () => void) => {
    callback?.()
  })
}

export function createKeyboardEventTarget() {
  const handlers = new Set<(event: KeyboardEvent) => void>()
  return {
    handlers,
    target: {
      addEventListener: vi.fn(
        (
          type: string,
          handler: EventListenerOrEventListenerObject,
          _options?: AddEventListenerOptions | boolean
        ) => {
          if (type === 'keydown' && typeof handler === 'function') {
            handlers.add(handler as (event: KeyboardEvent) => void)
          }
        }
      ),
      removeEventListener: vi.fn(
        (
          type: string,
          handler: EventListenerOrEventListenerObject,
          _options?: EventListenerOptions | boolean
        ) => {
          if (type === 'keydown' && typeof handler === 'function') {
            handlers.delete(handler as (event: KeyboardEvent) => void)
          }
        }
      )
    },
    dispatch(event: KeyboardEvent) {
      for (const handler of handlers) {
        handler(event)
      }
    }
  }
}

export function keyEvent(overrides: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: '',
    ctrlKey: false,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    ...overrides
  } as KeyboardEvent
}

export function createRect(width: number, height: number, left = 0, top = 0): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({})
  } as DOMRect
}

export function stubElementRect(element: HTMLElement, readRect: () => DOMRect): void {
  Object.defineProperty(element, 'getBoundingClientRect', {
    configurable: true,
    value: vi.fn(readRect)
  })
}

export function createMeasuredElement(args: {
  className?: () => string
  parentElement?: () => HTMLElement | null
  rect: () => DOMRect
}): HTMLElement {
  const element = new EventTarget() as HTMLElement
  Object.defineProperty(element, 'dataset', {
    configurable: true,
    value: {}
  })
  Object.defineProperty(element, 'classList', {
    configurable: true,
    value: {
      contains: (className: string): boolean =>
        (args.className?.() ?? '').split(/\s+/).includes(className)
    }
  })
  Object.defineProperty(element, 'parentElement', {
    configurable: true,
    get: () => args.parentElement?.() ?? null
  })
  stubElementRect(element, args.rect)
  return element
}

export function temporarilySetNavigatorUserAgent(userAgent: string): () => void {
  const originalDescriptor = Object.getOwnPropertyDescriptor(globalThis, 'navigator')
  const platform = userAgent.includes('Windows')
    ? 'Win32'
    : userAgent.includes('Macintosh')
      ? 'MacIntel'
      : 'Linux x86_64'
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { platform, userAgent }
  })
  return () => {
    if (originalDescriptor) {
      Object.defineProperty(globalThis, 'navigator', originalDescriptor)
    } else {
      delete (globalThis as { navigator?: Navigator }).navigator
    }
  }
}

export function sendTerminalInputThroughPane(pane: MockPane, data: string): void {
  const onDataMock = pane.terminal.onData as unknown as {
    mock: { calls: [[(data: string) => void] | []] }
  }
  const terminalInputHandler = onDataMock.mock.calls[0]?.[0]
  expect(terminalInputHandler).toBeTypeOf('function')
  terminalInputHandler?.(data)
}
