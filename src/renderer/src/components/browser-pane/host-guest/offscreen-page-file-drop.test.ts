// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import { bindOffscreenPageFileDrop } from './offscreen-page-file-drop'

function fileDrop(type: 'dragover' | 'drop', files: File[]): Event {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    clientX: 30,
    clientY: 50,
    dataTransfer: { types: ['Files'], files, dropEffect: 'none' }
  })
  return event
}

describe('bindOffscreenPageFileDrop', () => {
  it('hands dropped files to the page at the drop point and keeps them from Orca', () => {
    const host = document.createElement('div')
    const parent = document.createElement('div')
    parent.append(host)
    host.getBoundingClientRect = () => new DOMRect(10, 20, 300, 200)
    const drop = vi.fn()
    const parentDrop = vi.fn()
    parent.addEventListener('drop', parentDrop)
    bindOffscreenPageFileDrop(host, drop)
    const file = new File(['x'], 'a.txt')

    const over = fileDrop('dragover', [])
    host.dispatchEvent(over)
    const dropped = fileDrop('drop', [file])
    host.dispatchEvent(dropped)

    expect(over.defaultPrevented).toBe(true)
    expect(dropped.defaultPrevented).toBe(true)
    expect(drop).toHaveBeenCalledWith({ x: 20, y: 30 }, [file])
    expect(parentDrop).not.toHaveBeenCalled()
  })

  it('ignores drags that carry no OS files', () => {
    const host = document.createElement('div')
    const drop = vi.fn()
    bindOffscreenPageFileDrop(host, drop)
    const event = new Event('drop', { cancelable: true })
    Object.assign(event, { dataTransfer: { types: ['text/plain'], files: [] } })
    host.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(false)
    expect(drop).not.toHaveBeenCalled()
  })
})
