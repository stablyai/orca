import { describe, expect, it, vi } from 'vitest'
import { installMouseHideWhileTyping } from './mouse-hide-while-typing'

describe('installMouseHideWhileTyping', () => {
  function createMockTerminal() {
    const callbacks: (() => void)[] = []
    return {
      onData: vi.fn((cb: () => void) => {
        callbacks.push(cb)
        return { dispose: vi.fn() }
      }),
      callbacks
    }
  }

  function createMockContainer() {
    const listeners = new Map<string, Set<EventListenerOrEventListenerObject>>()
    const style = { cursor: '' as string }
    return {
      style,
      addEventListener: vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
        const set = listeners.get(type) ?? new Set()
        set.add(handler)
        listeners.set(type, set)
      }),
      removeEventListener: vi.fn((type: string, handler: EventListenerOrEventListenerObject) => {
        listeners.get(type)?.delete(handler)
      }),
      dispatchEvent: vi.fn((event: Event) => {
        listeners.get(event.type)?.forEach((handler) => {
          if (typeof handler === 'function') {
            handler(event)
          } else {
            handler.handleEvent(event)
          }
        })
        return true
      }),
      listeners
    }
  }

  it('hides cursor when terminal emits data', () => {
    const terminal = createMockTerminal()
    const container = createMockContainer()

    installMouseHideWhileTyping(terminal, container as unknown as HTMLElement)

    expect(terminal.onData).toHaveBeenCalledTimes(1)
    terminal.callbacks[0]?.()
    expect(container.style.cursor).toBe('none')
  })

  it('restores cursor on mousemove', () => {
    const terminal = createMockTerminal()
    const container = createMockContainer()
    container.style.cursor = 'none'

    installMouseHideWhileTyping(terminal, container as unknown as HTMLElement)

    container.dispatchEvent(new Event('mousemove'))

    expect(container.style.cursor).toBe('')
  })

  it('disposes listeners and restores cursor', () => {
    const terminal = createMockTerminal()
    const container = createMockContainer()
    container.style.cursor = 'none'

    const disposable = installMouseHideWhileTyping(terminal, container as unknown as HTMLElement)
    disposable.dispose()

    expect(container.style.cursor).toBe('')
    // After dispose, mousemove should not crash and cursor stays restored.
    container.dispatchEvent(new Event('mousemove'))
    expect(container.style.cursor).toBe('')
    expect(container.removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function))
  })
})
