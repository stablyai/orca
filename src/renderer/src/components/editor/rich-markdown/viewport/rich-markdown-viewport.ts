import type { Editor, EditorEvents } from '@tiptap/core'
import type { EditorView } from '@tiptap/pm/view'

type Scroll = () => void
type Handoff = { source: EventTarget | null; top: number; left: number; id: number }
const owners = new WeakMap<HTMLElement, RichMarkdownViewport>()
const views = new WeakMap<EditorView, RichMarkdownViewport>()

export function richMarkdownViewport(container: HTMLElement) {
  const owner = owners.get(container)
  return {
    current: () => !owner || owners.get(container) === owner,
    frame: (callback: () => void): void => {
      if (owner) {
        owner.frame(callback)
      } else {
        window.requestAnimationFrame(callback)
      }
    },
    scroll: (scroll: Scroll): void => {
      if (owner) {
        owner.scroll(scroll)
      } else {
        scroll()
      }
    }
  }
}

export function scrollRichMarkdownElementIntoView(
  element: HTMLElement,
  options: ScrollIntoViewOptions
): void {
  let container = element.parentElement
  while (container && !owners.has(container)) {
    container = container.parentElement
  }
  if (!container) {
    element.scrollIntoView(options)
    return
  }
  const scrollContainer = container
  const viewport = richMarkdownViewport(scrollContainer)
  viewport.scroll(() => {
    if (viewport.current() && scrollContainer.contains(element)) {
      element.scrollIntoView(options)
    }
  })
}

export function handleRichMarkdownViewportReveal(view: EditorView, reason?: string): boolean {
  return reason === 'focus' && views.get(view)?.current() === true
}

export function attachRichMarkdownViewport(
  editor: Editor,
  root: HTMLElement,
  container: HTMLElement
): () => void {
  return new RichMarkdownViewport(editor, root, container).retire
}

class RichMarkdownViewport {
  private active = true
  private pending: Handoff | null = null
  private methodDepth = 0
  private frames = new Set<number>()
  private nextId = 0
  private channel = new MessageChannel()
  private dom: HTMLElement
  private view: EditorView
  private window: Window
  private original: PropertyDescriptor | undefined
  private focus: HTMLElement['focus']

  constructor(
    private editor: Editor,
    private root: HTMLElement,
    private container: HTMLElement
  ) {
    this.view = editor.view
    this.dom = this.view.dom
    this.window = this.dom.ownerDocument.defaultView ?? window
    this.original = Object.getOwnPropertyDescriptor(this.dom, 'focus')
    const nativeFocus = this.dom.focus
    this.focus = (...args: Parameters<HTMLElement['focus']>): void => {
      this.methodDepth++
      try {
        nativeFocus.apply(this.dom, args.length === 0 ? [{ preventScroll: true }] : args)
      } finally {
        this.methodDepth--
      }
    }
    Object.defineProperty(this.dom, 'focus', {
      configurable: true,
      writable: true,
      value: this.focus
    })
    owners.set(container, this)
    views.set(this.view, this)
    this.channel.port1.onmessage = (event: MessageEvent<number>) => {
      if (this.pending?.id === event.data) {
        this.pending = null
      }
    }
    this.window.addEventListener('focusout', this.focusout, true)
    this.window.addEventListener('focus', this.onFocus, true)
    this.window.addEventListener('keydown', this.keydown, true)
    this.window.addEventListener('pointerdown', this.userInput, true)
    // Only wheel or touch over this scroller can move it; window listeners would run per editor.
    container.addEventListener('wheel', this.userInput, { passive: true })
    container.addEventListener('touchstart', this.userInput, { passive: true })
    editor.on('transaction', this.transaction)
  }

  current = (): boolean =>
    this.active &&
    !this.editor.isDestroyed &&
    this.editor.view === this.view &&
    this.root.contains(this.dom) &&
    this.container.contains(this.dom) &&
    owners.get(this.container) === this &&
    views.get(this.view) === this

  frame(callback: () => void): void {
    if (!this.current()) {
      return
    }
    const id = this.window.requestAnimationFrame(() => {
      this.frames.delete(id)
      if (this.current()) {
        callback()
      }
    })
    this.frames.add(id)
  }

  scroll(scroll: Scroll): void {
    if (!this.current()) {
      return
    }
    scroll()
    this.observeWrite()
  }

  private observeWrite = (): void => {
    if (this.pending && this.current()) {
      this.pending.top = this.container.scrollTop
      this.pending.left = this.container.scrollLeft
    }
  }

  private sample(source: EventTarget | null): void {
    if (!this.current()) {
      return
    }
    const id = ++this.nextId
    this.pending = { source, top: this.container.scrollTop, left: this.container.scrollLeft, id }
    // A microtask can run between native focusout and focus; expiration must wait for another task.
    this.channel.port2.postMessage(id)
  }

  private focusout = (event: FocusEvent): void => {
    this.pending = null
    if (event.relatedTarget === this.dom && event.target !== this.dom) {
      this.sample(event.target)
    }
  }

  private onFocus = (event: FocusEvent): void => {
    const pending = this.pending
    this.pending = null
    if (event.target !== this.dom || !this.current()) {
      return
    }
    if (this.methodDepth || !pending) {
      return
    }
    const body = this.dom.ownerDocument.body
    if (
      event.relatedTarget !== pending.source &&
      !(pending.source === body && !event.relatedTarget)
    ) {
      return
    }
    if (this.container.scrollTop !== pending.top || this.container.scrollLeft !== pending.left) {
      this.container.scrollTo({ top: pending.top, left: pending.left, behavior: 'instant' })
    }
  }

  private keydown = (event: KeyboardEvent): void => {
    this.pending = null
    if (event.key === 'Tab') {
      const active = this.dom.ownerDocument.activeElement
      if (!active || active === this.dom.ownerDocument.body) {
        this.sample(active)
      }
    } else if (!['Shift', 'Control', 'Alt', 'Meta'].includes(event.key)) {
      this.userInput()
    }
  }

  private userInput = (): void => {
    this.pending = null
  }

  private transaction = ({
    transaction,
    appendedTransactions
  }: EditorEvents['transaction']): void => {
    if (transaction.scrolledIntoView || appendedTransactions.some((tr) => tr.scrolledIntoView)) {
      this.observeWrite()
    }
  }

  retire = (): void => {
    this.active = false
    this.pending = null
    if (owners.get(this.container) === this) {
      owners.delete(this.container)
    }
    if (views.get(this.view) === this) {
      views.delete(this.view)
    }
    if (Object.getOwnPropertyDescriptor(this.dom, 'focus')?.value === this.focus) {
      if (this.original) {
        Object.defineProperty(this.dom, 'focus', this.original)
      } else {
        Reflect.deleteProperty(this.dom, 'focus')
      }
    }
    this.window.removeEventListener('focusout', this.focusout, true)
    this.window.removeEventListener('focus', this.onFocus, true)
    this.window.removeEventListener('keydown', this.keydown, true)
    this.window.removeEventListener('pointerdown', this.userInput, true)
    this.container.removeEventListener('wheel', this.userInput)
    this.container.removeEventListener('touchstart', this.userInput)
    this.editor.off('transaction', this.transaction)
    for (const id of this.frames) {
      this.window.cancelAnimationFrame(id)
    }
    this.frames.clear()
    this.channel.port1.onmessage = null
    this.channel.port1.close()
    this.channel.port2.close()
  }
}
