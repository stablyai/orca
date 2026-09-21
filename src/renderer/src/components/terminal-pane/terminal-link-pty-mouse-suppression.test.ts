// @vitest-environment happy-dom
import type { Terminal } from '@xterm/xterm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { installTerminalLinkPtyMouseSuppression } from './terminal-link-pty-mouse-suppression'

const activeSuppressions = new Set<ReturnType<typeof installTerminalLinkPtyMouseSuppression>>()

function createSuppression(
  deferPlain = true,
  shouldContinueDeferring: (event: MouseEvent) => boolean = () => true
): {
  element: HTMLDivElement
  suppression: ReturnType<typeof installTerminalLinkPtyMouseSuppression>
} {
  const element = document.createElement('div')
  document.body.append(element)
  const terminal = {
    element,
    options: { mouseEventsRequireAlt: false }
  } as unknown as Terminal
  const suppression = installTerminalLinkPtyMouseSuppression(
    terminal,
    () => true,
    () => deferPlain,
    shouldContinueDeferring
  )
  activeSuppressions.add(suppression)
  return { element, suppression }
}

function mouseEvent(
  type: 'mousedown' | 'mousemove' | 'mouseup',
  init: MouseEventInit = {}
): MouseEvent {
  return new MouseEvent(type, { bubbles: true, button: 0, ...init })
}

async function settleGesture(element: HTMLElement): Promise<void> {
  element.dispatchEvent(mouseEvent('mouseup'))
  element.click()
  await new Promise((resolve) => setTimeout(resolve, 0))
}

afterEach(() => {
  for (const suppression of activeSuppressions) {
    suppression.dispose()
  }
  activeSuppressions.clear()
  document.body.replaceChildren()
  vi.restoreAllMocks()
})

describe('terminal link PTY mouse suppression', () => {
  it('drops deferred mouse input when the completed action claims it', async () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    const forward = (data: string): void => {
      forwarded.push(data)
    }
    element.addEventListener('mousedown', () => suppression.handlePtyInput('\x1b[<0;1;1M', forward))
    element.addEventListener('mouseup', () => {
      suppression.handlePtyInput('\x1b[<0;1;1m', forward)
      suppression.claimAction()
    })

    element.dispatchEvent(mouseEvent('mousedown'))
    await settleGesture(element)

    expect(forwarded).toEqual([])
  })

  it('flushes deferred mouse input when the completed gesture stays child-owned', async () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    const forward = (data: string): void => {
      forwarded.push(data)
    }
    element.addEventListener('mousedown', () => suppression.handlePtyInput('\x1b[<0;1;1M', forward))
    element.addEventListener('mouseup', () => suppression.handlePtyInput('\x1b[<0;1;1m', forward))

    element.dispatchEvent(mouseEvent('mousedown'))
    await settleGesture(element)

    expect(forwarded).toEqual(['\x1b[<0;1;1M', '\x1b[<0;1;1m'])
  })

  it('forwards plain mouse input immediately when actions are disabled', () => {
    const { element, suppression } = createSuppression(false)
    const forwarded: string[] = []
    element.addEventListener('mousedown', () =>
      suppression.handlePtyInput('\x1b[M !!', (data) => forwarded.push(data))
    )

    element.dispatchEvent(mouseEvent('mousedown'))

    expect(forwarded).toEqual(['\x1b[M !!'])
  })

  it('flushes a dragged mouse sequence in order', async () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    const forward = (data: string): void => {
      forwarded.push(data)
    }
    element.addEventListener('mousedown', () => suppression.handlePtyInput('\x1b[<0;1;1M', forward))
    document.addEventListener(
      'mousemove',
      () => suppression.handlePtyInput('\x1b[<32;2;2M', forward),
      { once: true }
    )
    document.addEventListener(
      'mouseup',
      () => suppression.handlePtyInput('\x1b[<0;2;2m', forward),
      { once: true }
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    element.dispatchEvent(mouseEvent('mousemove', { buttons: 1, clientX: 10 }))
    await settleGesture(element)

    expect(forwarded).toEqual(['\x1b[<0;1;1M', '\x1b[<32;2;2M', '\x1b[<0;2;2m'])
  })

  it('releases a drag as soon as pointer eligibility is lost', () => {
    const { element, suppression } = createSuppression(true, (event) => event.clientX < 5)
    const forwarded: string[] = []
    const forward = (data: string): void => {
      forwarded.push(data)
    }
    element.addEventListener('mousedown', () => suppression.handlePtyInput('\x1b[<0;1;1M', forward))
    document.addEventListener(
      'mousemove',
      () => suppression.handlePtyInput('\x1b[<32;2;2M', forward),
      { once: true }
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    element.dispatchEvent(mouseEvent('mousemove', { buttons: 1, clientX: 10 }))

    expect(forwarded).toEqual(['\x1b[<0;1;1M', '\x1b[<32;2;2M'])
  })

  it('forwards keyboard input outside mouse dispatch while a click is pending', async () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    const forward = (data: string): void => {
      forwarded.push(data)
    }
    element.addEventListener('mousedown', () => suppression.handlePtyInput('\x1b[<0;1;1M', forward))
    document.addEventListener(
      'mouseup',
      () => suppression.handlePtyInput('\x1b[<0;1;1m', forward),
      { once: true }
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    suppression.handlePtyInput('key', forward)
    await settleGesture(element)

    expect(forwarded).toEqual(['key', '\x1b[<0;1;1M', '\x1b[<0;1;1m'])
  })

  it('flushes pending child input on blur', () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    element.addEventListener('mousedown', () =>
      suppression.handlePtyInput('\x1b[<0;1;1M', (data) => forwarded.push(data))
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    window.dispatchEvent(new Event('blur'))

    expect(forwarded).toEqual(['\x1b[<0;1;1M'])
  })

  it('flushes pending child input when disposed', () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    element.addEventListener('mousedown', () =>
      suppression.handlePtyInput('\x1b[<0;1;1M', (data) => forwarded.push(data))
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    suppression.dispose()

    expect(forwarded).toEqual(['\x1b[<0;1;1M'])
  })

  it('flushes an abandoned transaction before starting another gesture', () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    element.addEventListener('mousedown', () =>
      suppression.handlePtyInput('\x1b[<0;1;1M', (data) => forwarded.push(data))
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    element.dispatchEvent(mouseEvent('mousedown'))

    expect(forwarded).toEqual(['\x1b[<0;1;1M'])
  })

  it('installs global listeners only while a deferred gesture is active', async () => {
    const documentAdd = vi.spyOn(document, 'addEventListener')
    const windowAdd = vi.spyOn(window, 'addEventListener')
    const { element } = createSuppression()

    expect(documentAdd).not.toHaveBeenCalled()
    expect(windowAdd).not.toHaveBeenCalled()

    element.dispatchEvent(mouseEvent('mousedown'))

    expect(documentAdd).toHaveBeenCalledWith('mousemove', expect.any(Function), { capture: true })
    expect(windowAdd).toHaveBeenCalledWith('mouseup', expect.any(Function))

    await settleGesture(element)
    documentAdd.mockClear()
    windowAdd.mockClear()
    window.dispatchEvent(new Event('blur'))

    expect(documentAdd).not.toHaveBeenCalled()
    expect(windowAdd).not.toHaveBeenCalled()
  })

  it('fails open to the child when a deferred frame stream exceeds its budget', () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    const expected = Array.from({ length: 100 }, (_, index) => `\x1b[<32;${index};1M`)
    element.addEventListener('mousedown', () => {
      for (const frame of expected) {
        suppression.handlePtyInput(frame, (data) => forwarded.push(data))
      }
    })

    element.dispatchEvent(mouseEvent('mousedown'))

    expect(forwarded).toEqual(expected)
    expect(suppression.claimAction()).toBe(false)
  })

  it('forwards non-mouse focus reports during a claimed mouse gesture', async () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    const forward = (data: string): void => {
      forwarded.push(data)
    }
    element.addEventListener('mousedown', () => {
      suppression.handlePtyInput('\x1b[<0;1;1M', forward)
      suppression.handlePtyInput('\x1b[I', forward)
    })
    element.addEventListener('mouseup', () => suppression.claimAction())

    element.dispatchEvent(mouseEvent('mousedown'))
    await settleGesture(element)

    expect(forwarded).toEqual(['\x1b[I'])
  })

  it('flushes a pending press when the pointer leaves the document', () => {
    const { element, suppression } = createSuppression()
    const forwarded: string[] = []
    element.addEventListener('mousedown', () =>
      suppression.handlePtyInput('\x1b[<0;1;1M', (data) => forwarded.push(data))
    )

    element.dispatchEvent(mouseEvent('mousedown'))
    document.dispatchEvent(new MouseEvent('mouseleave'))

    expect(forwarded).toEqual(['\x1b[<0;1;1M'])
    expect(suppression.claimAction()).toBe(false)
  })
})
