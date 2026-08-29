import { beforeEach, describe, expect, it, vi } from 'vitest'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useMemo<T>(factory: () => T) {
      return factory()
    },
    useCallback<T extends (...args: never[]) => unknown>(callback: T) {
      return callback
    },
    useEffect() {
      return undefined
    },
    useRef<T>(initial: T) {
      return { current: initial }
    },
    useState<T>(initial: T | (() => T)) {
      const stateIndex = reactHookRuntime.index++
      if (!(stateIndex in reactHookRuntime.states)) {
        reactHookRuntime.states[stateIndex] =
          typeof initial === 'function' ? (initial as () => T)() : initial
      }
      const setState = (next: T | ((previous: T) => T)): void => {
        reactHookRuntime.states[stateIndex] =
          typeof next === 'function'
            ? (next as (previous: T) => T)(reactHookRuntime.states[stateIndex] as T)
            : next
      }
      return [reactHookRuntime.states[stateIndex] as T, setState] as const
    }
  }
})

vi.mock('lucide-react', () => ({
  Image: function Image(props: Record<string, unknown>) {
    return { type: 'Image', props }
  },
  RotateCcw: function RotateCcw(props: Record<string, unknown>) {
    return { type: 'RotateCcw', props }
  },
  X: function X(props: Record<string, unknown>) {
    return { type: 'X', props }
  },
  ZoomIn: function ZoomIn(props: Record<string, unknown>) {
    return { type: 'ZoomIn', props }
  },
  ZoomOut: function ZoomOut(props: Record<string, unknown>) {
    return { type: 'ZoomOut', props }
  }
}))

vi.mock('@/components/ui/dialog', () => ({
  Dialog: function Dialog(props: { children?: unknown }) {
    return { type: 'Dialog', props }
  },
  DialogContent: function DialogContent(props: { children?: unknown }) {
    return { type: 'DialogContent', props }
  },
  DialogDescription: function DialogDescription(props: { children?: unknown }) {
    return { type: 'DialogDescription', props }
  },
  DialogTitle: function DialogTitle(props: { children?: unknown }) {
    return { type: 'DialogTitle', props }
  }
}))

vi.mock('./PdfViewer', () => ({
  default: function PdfViewer(props: Record<string, unknown>) {
    return { type: 'PdfViewer', props }
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

function expandNode(node: unknown): unknown {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(expandNode)
  }
  const el = node as ReactElementLike
  if (typeof el.type === 'function') {
    return expandNode(el.type(el.props))
  }
  return {
    ...el,
    props: {
      ...el.props,
      children: expandNode(el.props?.children)
    }
  }
}

function findElementsByType(node: unknown, typeName: string): ReactElementLike[] {
  const results: ReactElementLike[] = []
  const visit = (current: unknown): void => {
    if (current == null || typeof current === 'string' || typeof current === 'number') {
      return
    }
    if (Array.isArray(current)) {
      for (const child of current) {
        visit(child)
      }
      return
    }
    const el = current as ReactElementLike
    if (el.type === typeName) {
      results.push(el)
    }
    visit(el.props?.children)
  }
  visit(node)
  return results
}

function findPreviewImage(node: unknown): ReactElementLike {
  const image = findElementsByType(node, 'img').find((element) => element.props.onError)
  if (!image) {
    throw new Error('preview image not found')
  }
  return image
}

async function renderExpandedImageViewer(content: string): Promise<unknown> {
  reactHookRuntime.index = 0
  const module = await import('./ImageViewer')
  return expandNode(
    module.default({
      content,
      filePath: '/repo/preview.png',
      mimeType: 'image/png'
    })
  )
}

function pngBase64(width: number): string {
  const bytes = Buffer.alloc(24)
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes)
  bytes.writeUInt32BE(13, 8)
  bytes.write('IHDR', 12, 'ascii')
  bytes.writeUInt32BE(width, 16)
  bytes.writeUInt32BE(1, 20)
  return bytes.toString('base64')
}

async function renderPdfViewerProps(
  scrollCacheKey?: string | null
): Promise<Record<string, unknown>> {
  reactHookRuntime.index = 0
  const module = await import('./ImageViewer')
  const rendered = expandNode(
    module.default({
      content: 'JVBERi0xLjQK',
      filePath: '/repo/report.pdf',
      mimeType: 'application/pdf',
      ...(scrollCacheKey === undefined ? {} : { scrollCacheKey })
    })
  )
  const [pdf] = findElementsByType(rendered, 'PdfViewer')
  if (!pdf) {
    throw new Error('PdfViewer not rendered')
  }
  return pdf.props
}

describe('ImageViewer PDF scroll cache key', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  // Why: nothing else pins the wiring, so a dropped prop anywhere between
  // EditorContent and PdfViewer would ship as silently amnesiac scrolling.
  it('forwards the scroll cache key to PdfViewer', async () => {
    expect(await renderPdfViewerProps('/repo/report.pdf::tab-2:pdf')).toMatchObject({
      filePath: '/repo/report.pdf',
      scrollCacheKey: '/repo/report.pdf::tab-2:pdf'
    })
  })

  it('passes null when no key is supplied, so unkeyed callers stay opted out', async () => {
    expect((await renderPdfViewerProps()).scrollCacheKey).toBeNull()
  })

  it('passes an explicit null through unchanged', async () => {
    expect((await renderPdfViewerProps(null)).scrollCacheKey).toBeNull()
  })
})

describe('ImageViewer preview source retry', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  it('retries an earlier failed source after a later source loads successfully', async () => {
    const failedContent = pngBase64(1)
    const loadedContent = pngBase64(2)

    const firstRender = await renderExpandedImageViewer(failedContent)
    const firstImage = findPreviewImage(firstRender)
    expect(firstImage.props.src).toBe(`data:image/png;base64,${failedContent}`)

    ;(firstImage.props.onError as () => void)()
    const failedRender = await renderExpandedImageViewer(failedContent)
    expect(findElementsByType(failedRender, 'Image')).toHaveLength(1)
    expect(findElementsByType(failedRender, 'img')).toHaveLength(0)

    const loadedRender = await renderExpandedImageViewer(loadedContent)
    const loadedImage = findPreviewImage(loadedRender)
    ;(
      loadedImage.props.onLoad as (event: {
        currentTarget: { naturalWidth: number; naturalHeight: number }
      }) => void
    )({ currentTarget: { naturalWidth: 12, naturalHeight: 10 } })

    const retryRender = await renderExpandedImageViewer(failedContent)
    const retryImage = findPreviewImage(retryRender)
    expect(retryImage.props.src).toBe(`data:image/png;base64,${failedContent}`)
  })

  it('shows a failure instead of loading an unsafe raster forever', async () => {
    const rendered = await renderExpandedImageViewer(pngBase64(32_769))

    expect(findElementsByType(rendered, 'Image')).toHaveLength(1)
    expect(findElementsByType(rendered, 'img')).toHaveLength(0)
  })
})

describe('ImageViewer pre-load layout box', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    vi.clearAllMocks()
  })

  // Why: the scroll surface's inner box is w-max/h-max, so percentage maxes resolve
  // to none and a 6000x4000 image lays out at natural resolution before onLoad.
  it('bounds both scroll surfaces with viewport units before the image loads', async () => {
    const images = findElementsByType(await renderExpandedImageViewer(pngBase64(1)), 'img')

    expect(images).toHaveLength(2)
    for (const image of images) {
      const className = String(image.props.className)
      expect(className).toContain('max-h-[100vh]')
      expect(className).toContain('max-w-[100vw]')
      expect(className).not.toContain('max-h-full')
      expect(className).not.toContain('max-w-full')
    }
  })
})
