import { useCallback, useRef } from 'react'
import type { editor, IScrollEvent } from 'monaco-editor'

type DiffViewport = {
  body: HTMLElement
  header: HTMLElement | null
  element: HTMLDivElement
  editor?: editor.IStandaloneDiffEditor
  height: number
  headerHeight: number
  width: number
  top: number
  layout?: { width: number; height: number }
  scrollTop: number
  syncing: boolean
}

type DiffViewportConnection = {
  mount: (diffEditor: editor.IStandaloneDiffEditor) => void
  dispose: () => void
}

const coordinators = new WeakMap<HTMLElement, DiffViewportCoordinator>()

class DiffViewportCoordinator {
  private readonly viewports = new Set<DiffViewport>()
  private readonly observer: ResizeObserver
  private frame: number | null = null

  constructor(private readonly container: HTMLElement) {
    this.observer = new ResizeObserver(this.schedule)
    this.observer.observe(container)
    container.addEventListener('scroll', this.schedule, { passive: true })
  }

  private readonly schedule = (): void => {
    if (this.frame !== null) {
      return
    }
    this.frame = requestAnimationFrame(() => {
      this.frame = null
      this.update()
    })
  }

  private update(): void {
    const containerRect = this.container.getBoundingClientRect()
    const height = this.container.clientHeight
    if (height <= 0) {
      return
    }

    // Read every section before Monaco writes DOM so neighboring editors cannot force alternating layouts.
    for (const viewport of this.viewports) {
      this.measure(viewport, containerRect.top + this.container.clientTop, height)
    }
    for (const viewport of this.viewports) {
      this.render(viewport)
    }
  }

  private measure(viewport: DiffViewport, containerTop: number, height: number): void {
    if (height <= 0) {
      return
    }
    const rect = viewport.body.getBoundingClientRect()
    if (rect.height <= 0) {
      return
    }
    viewport.headerHeight = viewport.header?.getBoundingClientRect().height ?? 0
    const contentTop = containerTop + viewport.headerHeight
    viewport.height = Math.floor(Math.min(Math.max(0, height - viewport.headerHeight), rect.height))
    viewport.width = Math.floor(rect.width)
    viewport.scrollTop = Math.max(
      0,
      Math.min(
        rect.height - viewport.height,
        viewport.editor
          ? viewport.editor.getModifiedEditor().getScrollHeight() - viewport.height
          : Infinity,
        contentTop - rect.top
      )
    )
    viewport.top =
      Math.max(rect.top, Math.min(contentTop, rect.bottom - viewport.height)) - contentTop
  }

  private render(viewport: DiffViewport): void {
    if (viewport.height <= 0) {
      return
    }
    const height = `${viewport.height}px`
    const top = `${viewport.headerHeight}px`
    if (viewport.element.style.top !== top) {
      viewport.element.style.top = top
    }
    if (viewport.element.style.height !== height) {
      viewport.element.style.height = height
    }
    const diffEditor = viewport.editor
    if (!diffEditor) {
      return
    }

    viewport.syncing = true
    try {
      if (
        viewport.layout?.width !== viewport.width ||
        viewport.layout?.height !== viewport.height
      ) {
        viewport.layout = { width: viewport.width, height: viewport.height }
        diffEditor.layout(viewport.layout, true)
        viewport.scrollTop = Math.min(
          viewport.scrollTop,
          Math.max(0, diffEditor.getModifiedEditor().getScrollHeight() - viewport.height)
        )
      }
      diffEditor.getOriginalEditor().setScrollTop(viewport.scrollTop)
      diffEditor.getModifiedEditor().setScrollTop(viewport.scrollTop)
    } finally {
      viewport.syncing = false
    }
  }

  add(element: HTMLDivElement, body: HTMLElement): DiffViewportConnection {
    const viewport: DiffViewport = {
      body,
      header: body.parentElement?.querySelector<HTMLElement>('[data-diff-section-header]') ?? null,
      element,
      height: 0,
      headerHeight: 0,
      width: 0,
      top: 0,
      scrollTop: 0,
      syncing: false
    }
    this.viewports.add(viewport)
    this.observer.observe(body)
    if (viewport.header) {
      this.observer.observe(viewport.header)
    }
    this.measure(
      viewport,
      this.container.getBoundingClientRect().top + this.container.clientTop,
      this.container.clientHeight
    )
    this.render(viewport)
    this.schedule()
    let subscriptions: { dispose: () => void }[] = []
    return {
      mount: (diffEditor) => {
        for (const subscription of subscriptions) {
          subscription.dispose()
        }
        viewport.editor = diffEditor
        viewport.layout = undefined
        this.render(viewport)
        const reveal = (codeEditor: editor.ICodeEditor, event?: IScrollEvent): void => {
          if (viewport.syncing || (event && !event.scrollTopChanged)) {
            return
          }
          const findFocused = codeEditor
            .getContainerDomNode()
            ?.querySelector('.find-widget')
            ?.contains(document.activeElement)
          const position = codeEditor.getPosition()
          if (!position || (!codeEditor.hasTextFocus() && !findFocused)) {
            this.schedule()
            return
          }
          this.measure(
            viewport,
            this.container.getBoundingClientRect().top + this.container.clientTop,
            this.container.clientHeight
          )
          const top =
            codeEditor.getTopForPosition(position.lineNumber, position.column) +
            viewport.top -
            viewport.scrollTop
          const bottom = top + codeEditor.getLineHeightForPosition(position)
          const delta =
            top < 0
              ? top
              : Math.max(0, bottom - (this.container.clientHeight - viewport.headerHeight))
          if (Math.abs(delta) >= 1) {
            this.container.scrollTop += delta
          }
          this.schedule()
        }
        subscriptions = [
          diffEditor
            .getOriginalEditor()
            .onDidScrollChange((event) => reveal(diffEditor.getOriginalEditor(), event)),
          diffEditor
            .getModifiedEditor()
            .onDidScrollChange((event) => reveal(diffEditor.getModifiedEditor(), event)),
          diffEditor
            .getOriginalEditor()
            .onDidChangeCursorPosition(() => reveal(diffEditor.getOriginalEditor())),
          diffEditor
            .getModifiedEditor()
            .onDidChangeCursorPosition(() => reveal(diffEditor.getModifiedEditor()))
        ]
      },
      dispose: () => {
        for (const subscription of subscriptions) {
          subscription.dispose()
        }
        subscriptions = []
        this.observer.unobserve(body)
        if (viewport.header) {
          this.observer.unobserve(viewport.header)
        }
        this.viewports.delete(viewport)
        if (this.viewports.size === 0) {
          if (this.frame !== null) {
            cancelAnimationFrame(this.frame)
          }
          this.observer.disconnect()
          this.container.removeEventListener('scroll', this.schedule)
          coordinators.delete(this.container)
        }
      }
    }
  }
}

export function useDiffSectionViewport(): {
  ref: (element: HTMLDivElement | null) => void
  mount: (diffEditor: editor.IStandaloneDiffEditor) => void
} {
  const connection = useRef<DiffViewportConnection | null>(null)
  const ref = useCallback((element: HTMLDivElement | null) => {
    connection.current?.dispose()
    connection.current = null
    const body = element?.parentElement
    const container = element?.closest<HTMLElement>('[data-diff-scroll-viewport]')
    if (!element || !body || !container) {
      return
    }
    let coordinator = coordinators.get(container)
    if (!coordinator) {
      coordinator = new DiffViewportCoordinator(container)
      coordinators.set(container, coordinator)
    }
    connection.current = coordinator.add(element, body)
  }, [])
  const mount = useCallback((diffEditor: editor.IStandaloneDiffEditor) => {
    connection.current?.mount(diffEditor)
  }, [])
  return { ref, mount }
}

export function scrollDiffEditorTo(
  codeEditor: Pick<editor.ICodeEditor, 'setScrollTop'>,
  scrollTop: number,
  domNode: HTMLElement
): void {
  const viewport = domNode.closest('[data-diff-editor-viewport]')
  const body = viewport?.parentElement
  const container = viewport?.closest<HTMLElement>('[data-diff-scroll-viewport]')
  if (!body || !container) {
    codeEditor.setScrollTop(scrollTop)
    return
  }
  const headerHeight =
    body.parentElement
      ?.querySelector<HTMLElement>('[data-diff-section-header]')
      ?.getBoundingClientRect().height ?? 0
  container.scrollTop +=
    body.getBoundingClientRect().top -
    container.getBoundingClientRect().top -
    container.clientTop -
    headerHeight +
    scrollTop
}
