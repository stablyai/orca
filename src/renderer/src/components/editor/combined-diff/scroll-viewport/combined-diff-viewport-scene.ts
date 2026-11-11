import { Scrollable } from 'monaco-editor/esm/vs/base/common/scrollable.js'
import { SmoothScrollableElement } from 'monaco-editor/esm/vs/base/browser/ui/scrollbar/scrollableElement.js'
import { CombinedDiffExtentIndex } from './combined-diff-extent-index'
import type { DiffItemLayout, DiffViewportLayout } from './combined-diff-layout'
import type { DiffViewportItem } from './combined-diff-viewport-owner'

export class CombinedDiffViewportScene {
  readonly root = document.createElement('div')
  readonly scene = document.createElement('div')
  readonly overflow = document.createElement('div')
  width = 0
  height = 0
  private scrollable: Scrollable | null = null
  private scrollbar: SmoothScrollableElement | null = null
  private host: HTMLDivElement | null = null
  private observer: ResizeObserver | null = null
  private disposed = false
  private applying = false
  private layout = new CombinedDiffExtentIndex().project(0, 0, 0, false)
  get mounted(): boolean {
    return this.host !== null
  }
  constructor(
    private readonly callbacks: {
      invalidate(): void
      focusChanged(): void
      scrollTo(top: number): void
      scrollBy(delta: number): void
    }
  ) {
    this.root.className = 'relative overflow-hidden'
    this.root.dataset.combinedDiffViewport = ''
    this.root.tabIndex = 0
    this.scene.className = 'relative w-full'
    this.overflow.className = 'monaco-editor'
    this.root.append(this.scene, this.overflow)
  }

  private initializeScrolling(): void {
    if (this.scrollable) {
      return
    }
    this.scrollable = new Scrollable({
      forceIntegerValues: false,
      smoothScrollDuration: 100,
      scheduleAtNextAnimationFrame: (callback) => {
        const frame = requestAnimationFrame(callback)
        return { dispose: () => cancelAnimationFrame(frame) }
      }
    })
    this.scrollbar = new SmoothScrollableElement(
      this.root,
      { vertical: 1, horizontal: 2, useShadows: false },
      this.scrollable
    )
    this.scrollable.onScroll(({ scrollTop }) => {
      if (this.applying || this.disposed) {
        return
      }
      const target = scrollTop - this.layout.leadingSlack
      this.callbacks.scrollTo(target)
    })
    this.root.addEventListener('scroll', this.forwardNativeScroll)
    this.root.addEventListener('keydown', this.onKeyDown)
    this.root.addEventListener('focusin', this.callbacks.focusChanged)
    this.root.addEventListener('focusout', this.callbacks.focusChanged)
  }
  mount(host: HTMLDivElement): () => void {
    this.observer?.disconnect()
    this.host = host
    this.initializeScrolling()
    const node = this.scrollbar!.getDomNode()
    node.style.height = '100%'
    node.style.width = '100%'
    host.append(node)
    const observer = new ResizeObserver(() => {
      if (this.observer !== observer) {
        return
      }
      this.width = host.clientWidth
      this.height = host.clientHeight
      this.callbacks.invalidate()
    })
    this.observer = observer
    observer.observe(host)
    this.width = host.clientWidth
    this.height = host.clientHeight
    this.callbacks.invalidate()
    return () => {
      observer.disconnect()
      if (this.observer === observer) {
        this.observer = null
        node.remove()
        this.host = null
      }
    }
  }
  prepare(
    index: CombinedDiffExtentIndex,
    viewport: DiffViewportLayout,
    attached: ReadonlySet<DiffViewportItem>
  ): void {
    for (const item of attached) {
      const layout = index.itemLayout(item.key, viewport, this.height)
      if (layout && item.node) {
        this.applyItem(item, layout, viewport, true)
      }
    }
  }
  render(input: {
    index: CombinedDiffExtentIndex
    attached: ReadonlySet<DiffViewportItem>
    focused: ReadonlySet<DiffViewportItem>
    logicalTop: number
    revision: number
    preserveSlack: boolean
  }): DiffViewportLayout {
    if (this.applying || this.disposed || !this.scrollable || !this.scrollbar) {
      return this.layout
    }
    this.applying = true
    try {
      this.layout = input.index.project(
        input.logicalTop,
        this.height,
        input.revision,
        input.preserveSlack
      )
      this.root.style.height = `${this.height}px`
      this.scene.style.height = `${this.layout.scrollHeight}px`
      this.scrollable.setScrollDimensions(
        {
          width: this.width,
          height: this.height,
          scrollWidth: this.width,
          scrollHeight: this.layout.scrollHeight
        },
        true
      )
      if (this.scrollbar.getScrollPosition().scrollTop !== this.layout.scrollTop) {
        this.scrollable.setScrollPositionNow({ scrollTop: this.layout.scrollTop })
      }
      const applied = this.scrollbar.getScrollPosition().scrollTop
      if (applied !== this.layout.scrollTop) {
        this.layout = input.index.project(
          applied - this.layout.leadingSlack,
          this.height,
          input.revision,
          input.preserveSlack
        )
      }
      const visible = new Map(this.layout.items.map((layout) => [layout.key, layout]))
      for (const item of input.attached) {
        const layout = visible.get(item.key) ?? input.index.itemLayout(item.key, this.layout)
        if (layout && item.node && !item.retired) {
          this.applyItem(item, layout, this.layout, layout.visible || input.focused.has(item))
        }
      }
      this.scene.style.transform = `translateY(${-this.layout.renderedTop}px)`
    } finally {
      this.applying = false
    }
    return this.layout
  }
  private applyItem(
    item: DiffViewportItem,
    layout: DiffItemLayout,
    viewport: DiffViewportLayout,
    visible: boolean
  ): void {
    const node = item.node!
    node.style.top = `${layout.renderedStart}px`
    node.style.height = `${layout.renderedHeight}px`
    node.style.width = `${this.width}px`
    node.style.visibility = visible ? 'visible' : 'hidden'
    const { header, body } = item.chrome
    if (header) {
      header.style.position = 'relative'
      header.style.top = '0'
      header.style.transform = `translateY(${Math.max(0, Math.min(viewport.renderedTop - layout.renderedStart, layout.renderedHeight - header.offsetHeight))}px)`
    }
    if (body && !item.binding) {
      body.style.transform = `translateY(${-layout.scrollOffset}px)`
    }
    if (!body && !item.binding && node.firstElementChild instanceof HTMLElement) {
      node.firstElementChild.style.transform = `translateY(${-layout.scrollOffset}px)`
    }
    item.binding?.apply(layout, viewport, this.width)
  }
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.defaultPrevented || event.altKey || event.metaKey || event.ctrlKey) {
      return
    }
    const target = event.target
    if (
      !(target instanceof Element) ||
      target.closest(
        '[data-combined-diff-native], input, textarea, select, [contenteditable="true"], [role="textbox"]'
      )
    ) {
      return
    }
    if (event.key === ' ' && target.closest('button, a, [role="button"]')) {
      return
    }
    let delta: number
    switch (event.key) {
      case 'ArrowDown':
        delta = 40
        break
      case 'ArrowUp':
        delta = -40
        break
      case 'PageDown':
        delta = this.height
        break
      case 'PageUp':
        delta = -this.height
        break
      case ' ':
        delta = event.shiftKey ? -this.height : this.height
        break
      case 'Home':
        delta = -this.layout.scrollHeight
        break
      case 'End':
        delta = this.layout.scrollHeight
        break
      default:
        return
    }
    event.preventDefault()
    this.callbacks.scrollBy(delta)
  }
  private forwardNativeScroll = (): void => {
    const delta = this.root.scrollTop
    if (!delta && !this.root.scrollLeft) {
      return
    }
    this.root.scrollTop = 0
    this.root.scrollLeft = 0
    this.callbacks.scrollBy(delta)
  }
  dispose(): void {
    this.disposed = true
    this.observer?.disconnect()
    this.root.removeEventListener('scroll', this.forwardNativeScroll)
    this.root.removeEventListener('keydown', this.onKeyDown)
    this.root.removeEventListener('focusin', this.callbacks.focusChanged)
    this.root.removeEventListener('focusout', this.callbacks.focusChanged)
    this.scrollbar?.dispose()
    this.scrollable?.dispose()
  }
}
