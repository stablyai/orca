import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ManagedPaneInternal } from './pane-manager-types'

const webglRendererMock = vi.hoisted(() => ({
  attachWebgl: vi.fn(),
  disposeWebgl: vi.fn()
}))

vi.mock('./pane-webgl-renderer', () => webglRendererMock)

vi.mock('./pane-divider', () => ({
  createDivider: vi.fn(() => createMockElement('pane-divider'))
}))

type TestElement = HTMLElement & {
  className: string
  children: TestElement[]
  parentElement: TestElement | null
  style: Record<string, string>
  appendChild: (child: TestElement) => TestElement
  replaceChild: (nextChild: TestElement, oldChild: TestElement) => TestElement
  remove: () => void
}

function createMockElement(className = ''): TestElement {
  const element = {
    className,
    children: [],
    parentElement: null,
    style: {},
    classList: {
      contains: (classToken: string): boolean => element.className.split(/\s+/).includes(classToken)
    },
    appendChild: (child: TestElement): TestElement => {
      element.children.push(child)
      child.parentElement = element
      return child
    },
    replaceChild: (nextChild: TestElement, oldChild: TestElement): TestElement => {
      const index = element.children.indexOf(oldChild)
      if (index >= 0) {
        element.children[index] = nextChild
      } else {
        element.children.push(nextChild)
      }
      nextChild.parentElement = element
      oldChild.parentElement = null
      return oldChild
    },
    remove: vi.fn()
  } as unknown as TestElement
  return element
}

function createPane(id: number, container = createMockElement('pane')): ManagedPaneInternal {
  const leafId = `${id}1111111-1111-4111-8111-111111111111` as never
  return {
    id,
    leafId,
    stablePaneId: leafId,
    container,
    xtermContainer: createMockElement(),
    linkTooltip: createMockElement(),
    terminal: {} as never,
    fitAddon: {} as never,
    searchAddon: {} as never,
    serializeAddon: {} as never,
    unicode11Addon: {} as never,
    webLinksAddon: {} as never,
    terminalGpuAcceleration: 'on',
    gpuRenderingEnabled: true,
    webglAttachmentDeferred: false,
    webglDisabledAfterContextLoss: false,
    hasComplexScriptOutput: false,
    webglAddon: {} as never,
    ligaturesAddon: null,
    fitResizeObserver: null,
    pendingObservedFitRafId: null,
    compositionHandler: null,
    pendingSplitScrollState: null,
    debugLabel: null
  }
}

function setupDocument(): void {
  vi.stubGlobal('document', {
    createElement: vi.fn(() => createMockElement())
  })
}

describe('insertPaneNextTo reparent frame', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('uses the caller-owned frame scheduler for WebGL reattach and refit', async () => {
    setupDocument()
    const { insertPaneNextTo } = await import('./pane-tree-ops')
    const parent = createMockElement('pane-split')
    const source = createPane(1)
    const target = createPane(2)
    parent.appendChild(target.container as TestElement)
    const frames: FrameRequestCallback[] = []
    const safeFit = vi.fn()

    insertPaneNextTo(source, target, 'right', {
      getRoot: () => parent,
      getStyleOptions: () => ({}),
      safeFit,
      refitPanesUnder: vi.fn(),
      requestPaneReparentFrame: (callback) => {
        frames.push(callback)
      }
    })

    expect(frames).toHaveLength(1)
    expect(safeFit).not.toHaveBeenCalled()

    frames[0]?.(16)

    expect(webglRendererMock.disposeWebgl).toHaveBeenCalledWith(source)
    expect(webglRendererMock.disposeWebgl).toHaveBeenCalledWith(target)
    expect(webglRendererMock.attachWebgl).toHaveBeenCalledWith(source)
    expect(webglRendererMock.attachWebgl).toHaveBeenCalledWith(target)
    expect(safeFit).toHaveBeenCalledWith(source)
    expect(safeFit).toHaveBeenCalledWith(target)
  })

  it('skips the deferred WebGL reattach and refit after manager destruction', async () => {
    setupDocument()
    const { insertPaneNextTo } = await import('./pane-tree-ops')
    const parent = createMockElement('pane-split')
    const source = createPane(1)
    const target = createPane(2)
    parent.appendChild(target.container as TestElement)
    const frames: FrameRequestCallback[] = []
    const safeFit = vi.fn()
    let destroyed = false

    insertPaneNextTo(source, target, 'right', {
      getRoot: () => parent,
      getStyleOptions: () => ({}),
      safeFit,
      refitPanesUnder: vi.fn(),
      isDestroyed: () => destroyed,
      requestPaneReparentFrame: (callback) => {
        frames.push(callback)
      }
    })

    destroyed = true
    frames[0]?.(16)

    expect(webglRendererMock.attachWebgl).not.toHaveBeenCalled()
    expect(safeFit).not.toHaveBeenCalled()
  })
})
