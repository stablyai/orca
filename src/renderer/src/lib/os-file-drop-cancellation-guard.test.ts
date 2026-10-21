// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ORCA_INTERNAL_FILE_DRAG_TYPE } from '../../../shared/native-file-drop'
import { installOsFileDropCancellationGuard } from './os-file-drop-cancellation-guard'
import { WORKSPACE_FILE_DRAG_SOURCE_MIME, WORKSPACE_FILE_PATHS_MIME } from './workspace-file-drag'

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
  it('cancels unclaimed OS files in capture and sets none in bubble', () => {
    dispose = installOsFileDropCancellationGuard()
    const target = document.createElement('div')
    document.body.append(target)
    const seenAtTarget = vi.fn((event: Event) => event.defaultPrevented)
    target.addEventListener('drop', seenAtTarget)
    const hover = drag(target, 'dragover')
    const drop = drag(target, 'drop')
    expect(hover.event.defaultPrevented).toBe(true)
    expect(hover.transfer.dropEffect).toBe('none')
    expect(seenAtTarget).toHaveReturnedWith(true)
    expect(drop.event.defaultPrevented).toBe(true)
    expect(drop.transfer.dropEffect).toBe('none')
  })

  it('leaves internal and non-file drags alone', () => {
    dispose = installOsFileDropCancellationGuard()
    const target = document.createElement('div')
    document.body.append(target)
    for (const types of [
      ['text/plain'],
      ['Files', ORCA_INTERNAL_FILE_DRAG_TYPE],
      ['Files', WORKSPACE_FILE_PATHS_MIME],
      ['Files', WORKSPACE_FILE_DRAG_SOURCE_MIME]
    ]) {
      const { event, transfer } = drag(target, 'drop', types)
      expect(event.defaultPrevented).toBe(false)
      expect(transfer.dropEffect).toBe('move')
    }
  })

  it('lets an owner stop propagation before the unclaimed sink', () => {
    dispose = installOsFileDropCancellationGuard()
    const target = document.createElement('div')
    document.body.append(target)
    target.addEventListener(
      'drop',
      (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) {
          event.dataTransfer.dropEffect = 'copy'
        }
      },
      true
    )
    const drop = drag(target, 'drop')
    expect(drop.event.defaultPrevented).toBe(true)
    expect(drop.transfer.dropEffect).toBe('copy')
  })

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
