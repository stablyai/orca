import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const reactHookRuntime = vi.hoisted(() => ({
  states: [] as unknown[],
  index: 0,
  cleanups: [] as (() => void)[]
}))

vi.mock('react', async () => {
  const actual = await vi.importActual<typeof import('react')>('react') // eslint-disable-line @typescript-eslint/consistent-type-imports -- vi.importActual requires inline import()
  return {
    ...actual,
    useMemo<T>(factory: () => T) {
      return factory()
    },
    // Why: effects run synchronously here so the object-URL lifecycle is
    // observable without a DOM renderer; cleanups collect for revocation asserts.
    useEffect(effect: () => void | (() => void)) {
      const cleanup = effect()
      if (typeof cleanup === 'function') {
        reactHookRuntime.cleanups.push(cleanup)
      }
      return undefined
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
  FileAudio: function FileAudio(props: Record<string, unknown>) {
    return { type: 'FileAudio', props }
  },
  FileVideo: function FileVideo(props: Record<string, unknown>) {
    return { type: 'FileVideo', props }
  }
}))

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
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

const createdObjectUrls: unknown[] = []
const revokedObjectUrls: string[] = []

async function renderMediaViewer(props: {
  content: string
  filePath: string
  mimeType: string
}): Promise<unknown> {
  const module = await import('./MediaViewer')
  // Why: two passes — the first render runs the decode effect, the second
  // observes the state it committed, mirroring React's post-effect render.
  reactHookRuntime.index = 0
  module.default(props)
  reactHookRuntime.index = 0
  return module.default(props)
}

describe('MediaViewer', () => {
  beforeEach(() => {
    reactHookRuntime.states = []
    reactHookRuntime.index = 0
    reactHookRuntime.cleanups = []
    createdObjectUrls.length = 0
    revokedObjectUrls.length = 0
    vi.clearAllMocks()
    vi.spyOn(URL, 'createObjectURL').mockImplementation((blob: unknown) => {
      createdObjectUrls.push(blob)
      return `blob:mock-${createdObjectUrls.length}`
    })
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation((url: string) => {
      revokedObjectUrls.push(url)
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('renders a native video element for video mime types', async () => {
    const rendered = await renderMediaViewer({
      content: Buffer.from('webm-bytes').toString('base64'),
      filePath: '/repo/clip.webm',
      mimeType: 'video/webm'
    })
    const [video] = findElementsByType(rendered, 'video')
    expect(video).toBeDefined()
    expect(video.props.controls).toBe(true)
    expect(video.props.src).toMatch(/^blob:mock-/)
    expect(findElementsByType(rendered, 'audio')).toHaveLength(0)
  })

  it('renders a native audio element for audio mime types', async () => {
    const rendered = await renderMediaViewer({
      content: Buffer.from('mp3-bytes').toString('base64'),
      filePath: '/repo/song.mp3',
      mimeType: 'audio/mpeg'
    })
    const [audio] = findElementsByType(rendered, 'audio')
    expect(audio).toBeDefined()
    expect(audio.props.controls).toBe(true)
    expect(findElementsByType(rendered, 'video')).toHaveLength(0)
  })

  it('shows the error state when the base64 payload cannot decode', async () => {
    const rendered = await renderMediaViewer({
      content: '%%%not-base64%%%',
      filePath: '/repo/broken.mp4',
      mimeType: 'video/mp4'
    })
    expect(findElementsByType(rendered, 'video')).toHaveLength(0)
    expect(JSON.stringify(rendered)).toContain('Failed to load file preview')
    expect(JSON.stringify(rendered)).toContain('broken.mp4')
  })

  it('revokes the object URL on cleanup so playback unloads with the tab', async () => {
    await renderMediaViewer({
      content: Buffer.from('webm-bytes').toString('base64'),
      filePath: '/repo/clip.webm',
      mimeType: 'video/webm'
    })
    expect(createdObjectUrls.length).toBeGreaterThan(0)
    for (const cleanup of reactHookRuntime.cleanups.splice(0)) {
      cleanup()
    }
    expect(revokedObjectUrls).toContain('blob:mock-1')
  })
})
