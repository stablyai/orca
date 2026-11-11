import { Scrollable } from 'monaco-editor/esm/vs/base/common/scrollable.js'
import { SmoothScrollableElement } from 'monaco-editor/esm/vs/base/browser/ui/scrollbar/scrollableElement.js'
import {
  layoutDiffViewport,
  type DiffItemExtent,
  type DiffViewportLayout
} from './combined-diff-layout'
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
  private mountRevision = 0
  private disposed = false
  private applying = false
  private layout = layoutDiffViewport({ items: [], height: 0, logicalTop: 0, revision: 0 })
  get mounted(): boolean {
    return this.host !== null
  }
  constructor(
    private readonly callbacks: {
      invalidate(): void
      scrollTo(top: number): void
      scrollBy(delta: number): void
      unmount(): void
    }
  ) {
    this.root.className = 'relative overflow-hidden'
    this.root.dataset.combinedDiffViewport = ''
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
    this.root.addEventListener('focusin', this.callbacks.invalidate)
    this.root.addEventListener('focusout', this.callbacks.invalidate)
  }
  retain(): () => void {
    this.mountRevision++
    return () => {
      const revision = ++this.mountRevision
      queueMicrotask(() => {
        if (!this.host && revision === this.mountRevision) {
          this.callbacks.unmount()
        }
      })
    }
  }

  mount(host: HTMLDivElement): () => void {
    this.mountRevision++
    this.host = host
    this.initializeScrolling()
    const node = this.scrollbar!.getDomNode()
    node.style.height = '100%'
    node.style.width = '100%'
    host.append(node)
    this.observer = new ResizeObserver(() => {
      this.width = host.clientWidth
      this.height = host.clientHeight
      this.callbacks.invalidate()
    })
    this.observer.observe(host)
    this.width = host.clientWidth
    this.height = host.clientHeight
    this.callbacks.invalidate()
    return () => {
      this.observer?.disconnect()
      this.observer = null
      node.remove()
      this.host = null
      const revision = ++this.mountRevision
      queueMicrotask(() => {
        if (!this.host && revision === this.mountRevision) {
          this.callbacks.unmount()
        }
      })
    }
  }
  render(input: {
    extents: readonly DiffItemExtent[]
    order: readonly DiffViewportItem[]
    logicalTop: number
    revision: number
    preserveSlack: boolean
  }): DiffViewportLayout {
    if (this.applying || this.disposed || !this.scrollable || !this.scrollbar) {
      return this.layout
    }
    this.applying = true
    try {
      this.layout = layoutDiffViewport({
        items: input.extents,
        height: this.height,
        logicalTop: input.logicalTop,
        revision: input.revision,
        preserveSlack: input.preserveSlack
      })
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
        this.layout = layoutDiffViewport({
          items: input.extents,
          height: this.height,
          logicalTop: applied - this.layout.leadingSlack,
          revision: input.revision,
          preserveSlack: input.preserveSlack
        })
      }
      for (let index = 0; index < input.order.length; index++) {
        const item = input.order[index]
        const layout = this.layout.items[index]
        const node = item.node
        if (node) {
          node.style.top = `${layout.renderedStart}px`
          node.style.height = `${layout.renderedHeight}px`
          node.style.width = `${this.width}px`
          node.style.visibility = layout.visible ? 'visible' : 'hidden'
          const header = node.querySelector<HTMLElement>('[data-combined-diff-section-header]')
          if (header) {
            header.style.position = 'relative'
            header.style.top = '0'
            header.style.transform = `translateY(${Math.max(
              0,
              Math.min(
                this.layout.renderedTop - layout.renderedStart,
                layout.renderedHeight - header.offsetHeight
              )
            )}px)`
          }
          const body = node.querySelector<HTMLElement>('[data-combined-diff-body]')
          if (body && !item.binding) {
            body.style.transform = `translateY(${-layout.scrollOffset}px)`
          }
          if (!body && !item.binding && node.firstElementChild instanceof HTMLElement) {
            node.firstElementChild.style.transform = `translateY(${-layout.scrollOffset}px)`
          }
          item.binding?.apply(layout, this.layout, this.width)
        }
      }
      this.scene.style.transform = `translateY(${-this.layout.renderedTop}px)`
    } finally {
      this.applying = false
    }
    return this.layout
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
    this.mountRevision++
    this.observer?.disconnect()
    this.root.removeEventListener('scroll', this.forwardNativeScroll)
    this.root.removeEventListener('focusin', this.callbacks.invalidate)
    this.root.removeEventListener('focusout', this.callbacks.invalidate)
    this.scrollbar?.dispose()
    this.scrollable?.dispose()
  }
}
