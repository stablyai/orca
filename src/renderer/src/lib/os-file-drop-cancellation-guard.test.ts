// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest'
import { installOsFileDropCancellationGuard } from './os-file-drop-cancellation-guard'

let dispose: (() => void) | null = null

function drag(
  target: Element,
  type: 'dragover' | 'drop',
  types: string[] = ['Files']
): { event: Event; transfer: { dropEffect: string } } {
  const transfer = { types, dropEffect: 'move' }
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  target.dispatchEvent(event)
  return { event, transfer }
}

afterEach(() => {
  dispose?.()
  dispose = null
  document.body.replaceChildren()
})

describe('OS file drop cancellation guard', () => {
  it('preserves a drop claimed by an earlier document capture listener', () => {
    const claim = (event: DragEvent): void => {
      event.preventDefault()
      if (event.dataTransfer) {
        event.dataTransfer.dropEffect = 'copy'
      }
    }
    document.addEventListener('drop', claim, true)
    try {
      dispose = installOsFileDropCancellationGuard()
      const target = document.createElement('div')
      document.body.append(target)
      const drop = drag(target, 'drop')
      expect(drop.event.defaultPrevented).toBe(true)
      expect(drop.transfer.dropEffect).toBe('copy')
    } finally {
      document.removeEventListener('drop', claim, true)
    }
  })

  it('installs only once and removes the listeners on disposal', () => {
    dispose = installOsFileDropCancellationGuard()
    expect(installOsFileDropCancellationGuard()).toBe(dispose)
    dispose()
    dispose = null
    const target = document.createElement('div')
    document.body.append(target)
    const drop = drag(target, 'drop')
    expect(drop.event.defaultPrevented).toBe(false)
    expect(drop.transfer.dropEffect).toBe('move')
  })
})
