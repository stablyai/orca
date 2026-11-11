// @vitest-environment happy-dom
import { expect, it, vi } from 'vitest'
import { installDiffEditorShiftWheelScroll } from '../../diff/monaco-view/diff-editor-shift-wheel-scroll'
import { CombinedDiffViewportOwner } from './combined-diff-viewport-owner'

function viewport(): { owner: CombinedDiffViewportOwner; host: HTMLDivElement; close(): void } {
  const owner = new CombinedDiffViewportOwner()
  const host = document.createElement('div')
  Object.defineProperties(host, {
    clientWidth: { value: 800 },
    clientHeight: { value: 500 }
  })
  document.body.append(host)
  const unmount = owner.mount(host)
  return {
    owner,
    host,
    close: () => {
      unmount()
      owner.dispose()
      host.remove()
    }
  }
}
function row(key: string, index: number, height = 1000, generation = 'ready') {
  return { key, index, height, generation, collapsed: false }
}
async function commit(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
}
function bindPoint(owner: CombinedDiffViewportOwner, key: string, offset: number) {
  const item = owner.getItem(key)!
  const point = {
    resolveScrollTop: (displacement: number) =>
      owner.getItemLayout(key)!.start + offset - displacement,
    project: () => owner.getItemLayout(key)!.start + offset - owner.getScrollTop(),
    dispose: () => {}
  }
  owner.bind(item, {
    apply: () => {},
    readHeight: () => 1000,
    capture: () => point,
    hasFocus: () => false,
    detach: () => {}
  })
  return point
}
function wheel(target: HTMLElement, deltaY: number, init: WheelEventInit = {}): WheelEvent {
  const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY, ...init })
  target.dispatchEvent(event)
  return event
}

it('keeps the beginning when a loading edge grows before the next native row', async () => {
  const view = viewport()
  const { owner } = view
  try {
    owner.setItems([row('first', 0, 88, 'loading'), row('next', 1)])
    bindPoint(owner, 'next', 28)
    await commit()
    expect(owner.getScrollTop()).toBe(0)
    owner.setItems([row('first', 0), row('next', 1)])
    await commit()
    expect(owner.getScrollTop()).toBe(0)
    owner.measure(owner.getItem('first')!, 1200)
    await commit()
    expect(owner.getAnchor()).toEqual({ key: 'first', offset: 0 })
    expect(owner.getScrollTop()).toBe(0)
  } finally {
    view.close()
  }
})

it('keeps a non-native bottom edge at its exact boundary while scrolling upward', async () => {
  const view = viewport()
  const { owner } = view
  try {
    owner.setItems([row('first', 0), row('bottom', 1, 88, 'loading'), row('tail', 2)])
    bindPoint(owner, 'first', 980)
    await commit()
    owner.input(900)
    owner.input(-312)
    expect(owner.getScrollTop()).toBe(588)
    owner.setItems([row('first', 0), row('bottom', 1), row('tail', 2)])
    await commit()
    expect(owner.getScrollTop()).toBe(1500)
    expect(owner.getItemLayout('bottom')!.start - owner.getScrollTop()).toBe(-500)
  } finally {
    view.close()
  }
})

it('preserves an explicit note request across a non-native edge without repeating focus', async () => {
  const view = viewport()
  const { owner } = view
  try {
    owner.setItems([row('first', 0, 88, 'loading'), row('next', 1)])
    const point = bindPoint(owner, 'next', 28)
    const focus = vi.fn()
    await commit()
    owner.reveal(owner.getItem('next')!, () => point, focus)
    await commit()
    expect(focus).toHaveBeenCalledTimes(1)
    expect(owner.getScrollTop()).toBe(0)
    owner.setItems([row('first', 0), row('next', 1)])
    await commit()
    expect(owner.getScrollTop()).toBe(912)
    expect(point.project()).toBe(116)
    expect(focus).toHaveBeenCalledTimes(1)
  } finally {
    view.close()
  }
})

it('routes browser wheel units through the owner without tick normalization or duplicate listeners', async () => {
  const view = viewport()
  const { owner } = view
  try {
    owner.setItems([row('first', 0, 10000)])
    await commit()
    expect(wheel(owner.scene, 120).defaultPrevented).toBe(true)
    expect(owner.getScrollTop()).toBe(120)
    wheel(owner.scene, 7.5)
    expect(owner.getScrollTop()).toBe(127.5)
    wheel(owner.scene, 2, { deltaMode: WheelEvent.DOM_DELTA_LINE })
    expect(owner.getScrollTop()).toBe(159.5)
    wheel(owner.scene, 1, { deltaMode: WheelEvent.DOM_DELTA_PAGE })
    expect(owner.getScrollTop()).toBe(659.5)
    wheel(owner.scene, 120, { ctrlKey: true })
    wheel(owner.scene, 0, { deltaX: 120 })
    const consumed = (event: WheelEvent): void => event.preventDefault()
    owner.scene.addEventListener('wheel', consumed)
    wheel(owner.scene, 120)
    owner.scene.removeEventListener('wheel', consumed)
    expect(owner.getScrollTop()).toBe(659.5)
    const detach = owner.mount(view.host)
    detach()
    wheel(owner.scene, 120)
    expect(owner.getScrollTop()).toBe(659.5)
    owner.mount(view.host)
    wheel(owner.scene, 120)
    expect(owner.getScrollTop()).toBe(779.5)
    owner.input(-10000)
    expect(wheel(owner.scene, -120).defaultPrevented).toBe(false)
    expect(owner.getScrollTop()).toBe(0)
  } finally {
    view.close()
  }
})

it('yields to nested scrolling and containment, chaining outward only at an inner boundary', async () => {
  const view = viewport()
  const { owner } = view
  const textarea = document.createElement('textarea')
  textarea.style.overflowY = 'auto'
  Object.defineProperties(textarea, {
    scrollHeight: { value: 500 },
    clientHeight: { value: 100 }
  })
  owner.scene.append(textarea)
  try {
    owner.setItems([row('first', 0, 10000)])
    await commit()
    textarea.scrollTop = 50
    expect(wheel(textarea, 120).defaultPrevented).toBe(false)
    expect(owner.getScrollTop()).toBe(0)
    textarea.scrollTop = 400
    expect(wheel(textarea, 120).defaultPrevented).toBe(true)
    expect(owner.getScrollTop()).toBe(120)
    textarea.style.overscrollBehaviorY = 'contain'
    expect(wheel(textarea, 120).defaultPrevented).toBe(false)
    expect(owner.getScrollTop()).toBe(120)
    textarea.style.overscrollBehaviorY = 'auto'
    textarea.scrollTop = 0
    wheel(textarea, -7.5)
    expect(owner.getScrollTop()).toBe(112.5)
    const horizontal = document.createElement('div')
    horizontal.style.overflow = 'auto'
    Object.defineProperties(horizontal, {
      scrollWidth: { value: 500 },
      clientWidth: { value: 100 }
    })
    owner.scene.append(horizontal)
    horizontal.scrollLeft = 50
    expect(wheel(horizontal, 7.5, { deltaX: 120 }).defaultPrevented).toBe(false)
    expect(owner.getScrollTop()).toBe(112.5)
    horizontal.scrollLeft = 400
    expect(wheel(horizontal, 7.5, { deltaX: 120 }).defaultPrevented).toBe(true)
    expect(owner.getScrollTop()).toBe(120)
    horizontal.style.overscrollBehaviorX = 'contain'
    expect(wheel(horizontal, 7.5, { deltaX: 120 }).defaultPrevented).toBe(false)
    expect(owner.getScrollTop()).toBe(120)
  } finally {
    view.close()
  }
})

it('keeps pane shift-wheel horizontal and yields wrapped-pane gestures to the outer owner', async () => {
  const view = viewport()
  const { owner } = view
  const pane = document.createElement('div')
  owner.scene.append(pane)
  let horizontal = 0
  let scrollWidth = 1200
  const editor = {
    getContainerDomNode: () => pane,
    getScrollLeft: () => horizontal,
    setScrollLeft: (value: number) => {
      horizontal = value
    },
    getScrollWidth: () => scrollWidth,
    getLayoutInfo: () => ({ contentWidth: 500 })
  }
  const cleanup = installDiffEditorShiftWheelScroll({
    getOriginalEditor: () => editor,
    getModifiedEditor: () => editor
  })
  try {
    owner.setItems([row('first', 0, 10000)])
    await commit()
    wheel(pane, 120, { shiftKey: true })
    expect(horizontal).toBe(120)
    expect(owner.getScrollTop()).toBe(0)
    scrollWidth = 500
    wheel(pane, 120, { shiftKey: true })
    expect(horizontal).toBe(120)
    expect(owner.getScrollTop()).toBe(120)
  } finally {
    cleanup()
    view.close()
  }
})
