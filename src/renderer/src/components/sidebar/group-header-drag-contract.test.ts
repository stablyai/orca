// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest'
import { isGroupHeaderDragHandleTarget } from './group-header-drag-contract'
import { isHeaderActionTarget } from './header-drag-target-predicates'

function build(html: string): { root: HTMLElement; handle: HTMLElement; button: HTMLElement } {
  const root = document.createElement('div')
  root.innerHTML = html
  return {
    root,
    handle: root.querySelector('[data-group-header-drag-handle]') as HTMLElement,
    button: root.querySelector('button') as HTMLElement
  }
}

describe('group header drag predicates', () => {
  it('recognizes the drag handle as a drag target', () => {
    const { root, handle } = build('<span data-group-header-drag-handle></span>')
    expect(isGroupHeaderDragHandleTarget(handle, root)).toBe(true)
  })
  it('rejects a non-handle element', () => {
    const { root, button } = build('<button></button>')
    expect(isGroupHeaderDragHandleTarget(button, root)).toBe(false)
  })
  it('treats buttons inside the header as action targets', () => {
    const { root, button } = build('<button></button>')
    expect(isHeaderActionTarget(button, root)).toBe(true)
  })
})
