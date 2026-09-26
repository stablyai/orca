// @vitest-environment happy-dom

import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRadixBodyPointerEventsRecovery } from './useRadixBodyPointerEventsRecovery'

const frames = new Map<number, FrameRequestCallback>()
let nextFrameId = 0
const requestFrame = vi.fn((callback: FrameRequestCallback): number => {
  const id = ++nextFrameId
  frames.set(id, callback)
  return id
})
const cancelFrame = vi.fn((id: number): void => {
  frames.delete(id)
})

async function flushMutations(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0))
  })
}

function flushFrames(): void {
  const pending = Array.from(frames.values())
  frames.clear()
  act(() => {
    for (const callback of pending) {
      callback(0)
    }
  })
}

function appendModal(slot = 'dialog-content'): HTMLDivElement {
  const modal = document.createElement('div')
  modal.dataset.slot = slot
  modal.dataset.state = 'open'
  document.body.append(modal)
  return modal
}

beforeEach(() => {
  document.body.replaceChildren()
  document.body.style.pointerEvents = ''
  frames.clear()
  nextFrameId = 0
  vi.clearAllMocks()
  vi.stubGlobal('requestAnimationFrame', requestFrame)
  vi.stubGlobal('cancelAnimationFrame', cancelFrame)
})

afterEach(() => {
  cleanup()
  document.body.replaceChildren()
  document.body.style.pointerEvents = ''
  vi.unstubAllGlobals()
})

describe('useRadixBodyPointerEventsRecovery', () => {
  it('does not schedule recovery for unlocked child and style mutations', async () => {
    const output = document.createElement('div')
    document.body.append(output)
    renderHook(() => useRadixBodyPointerEventsRecovery())
    await flushMutations()
    expect(requestFrame).not.toHaveBeenCalled()

    for (let index = 0; index < 10; index += 1) {
      output.append(document.createTextNode(String(index)))
      output.style.opacity = index % 2 === 0 ? '0.5' : '1'
      await flushMutations()
      flushFrames()
    }

    expect(requestFrame).not.toHaveBeenCalled()
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('repairs a stale lock present at mount without scheduling another recovery', async () => {
    document.body.style.pointerEvents = 'none'
    renderHook(() => useRadixBodyPointerEventsRecovery())
    expect(frames.size).toBe(1)

    flushFrames()
    await flushMutations()

    expect(document.body.style.pointerEvents).toBe('')
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(0)
  })

  it('observes a body style lock after an unlocked mount', async () => {
    renderHook(() => useRadixBodyPointerEventsRecovery())
    await flushMutations()
    flushFrames()
    document.body.style.pointerEvents = 'none'
    await flushMutations()
    expect(frames.size).toBe(1)

    flushFrames()

    expect(document.body.style.pointerEvents).toBe('')
  })

  it.each(['dialog-content', 'dialog-overlay', 'sheet-content', 'sheet-overlay'])(
    'keeps an active %s locked and repairs its removed portal',
    async (slot) => {
      const modal = appendModal(slot)
      document.body.style.pointerEvents = 'none'
      renderHook(() => useRadixBodyPointerEventsRecovery())
      flushFrames()
      expect(document.body.style.pointerEvents).toBe('none')

      modal.remove()
      await flushMutations()
      expect(frames.size).toBe(1)
      flushFrames()

      expect(document.body.style.pointerEvents).toBe('')
    }
  )

  it('rechecks for a modal opened after recovery was queued', async () => {
    document.body.style.pointerEvents = 'none'
    renderHook(() => useRadixBodyPointerEventsRecovery())
    appendModal()
    await flushMutations()
    expect(frames.size).toBe(1)

    flushFrames()

    expect(document.body.style.pointerEvents).toBe('none')
  })

  it('rechecks a modal that starts closing before the queued frame', () => {
    const modal = appendModal()
    document.body.style.pointerEvents = 'none'
    renderHook(() => useRadixBodyPointerEventsRecovery())
    modal.dataset.state = 'closed'

    flushFrames()

    expect(document.body.contains(modal)).toBe(true)
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('retains the lock when another modal remains after a portal is removed', async () => {
    const dialog = appendModal()
    const sheet = appendModal('sheet-content')
    document.body.style.pointerEvents = 'none'
    renderHook(() => useRadixBodyPointerEventsRecovery())
    flushFrames()

    dialog.remove()
    await flushMutations()
    flushFrames()
    expect(document.body.style.pointerEvents).toBe('none')

    sheet.remove()
    await flushMutations()
    flushFrames()
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('rechecks a body unlocked before the queued frame without overwriting its value', async () => {
    document.body.style.pointerEvents = 'none'
    renderHook(() => useRadixBodyPointerEventsRecovery())
    document.body.style.pointerEvents = 'auto'
    await flushMutations()

    expect(frames.size).toBe(1)
    expect(cancelFrame).not.toHaveBeenCalled()
    flushFrames()
    expect(document.body.style.pointerEvents).toBe('auto')
  })

  it('preserves queued work across unlock and relock transitions', async () => {
    document.body.style.pointerEvents = 'none'
    renderHook(() => useRadixBodyPointerEventsRecovery())
    document.body.style.pointerEvents = ''
    await flushMutations()
    document.body.style.pointerEvents = 'none'
    await flushMutations()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(cancelFrame).not.toHaveBeenCalled()
    flushFrames()
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('coalesces simultaneous style and child mutations and later batches into one frame', async () => {
    const output = document.createElement('div')
    document.body.append(output)
    renderHook(() => useRadixBodyPointerEventsRecovery())
    await flushMutations()
    flushFrames()
    requestFrame.mockClear()

    document.body.style.pointerEvents = 'none'
    output.append(document.createElement('span'))
    output.style.opacity = '0.5'
    await flushMutations()
    output.replaceChildren(document.createElement('span'))
    output.style.opacity = '1'
    await flushMutations()

    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(frames.size).toBe(1)
    flushFrames()
    expect(document.body.style.pointerEvents).toBe('')
  })

  it('cancels the queued frame and disconnects mutations on unmount', async () => {
    document.body.style.pointerEvents = 'none'
    const hook = renderHook(() => useRadixBodyPointerEventsRecovery())
    hook.unmount()

    expect(cancelFrame).toHaveBeenCalledExactlyOnceWith(1)
    expect(frames.size).toBe(0)
    document.body.append(document.createElement('div'))
    document.body.style.opacity = '0.5'
    await flushMutations()
    expect(requestFrame).toHaveBeenCalledTimes(1)
    expect(document.body.style.pointerEvents).toBe('none')
    document.body.style.opacity = ''
  })
})
