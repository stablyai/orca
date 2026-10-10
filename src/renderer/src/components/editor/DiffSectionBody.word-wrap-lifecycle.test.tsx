// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useEffect, useRef, type ComponentProps } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DiffSectionBody } from './DiffSectionBody'

const { mountedEditors, syncWordWrap, cleanupShiftWheel, createEditor } = vi.hoisted(() => {
  function createEditor() {
    const listeners = new Set<() => void>()
    const modified = {
      onDidDispose: (listener: () => void) => {
        listeners.add(listener)
        return { dispose: () => listeners.delete(listener) }
      }
    }
    return {
      editor: {
        getModifiedEditor: () => modified,
        onDidDispose: vi.fn(() => ({ dispose: vi.fn() }))
      },
      disposeModified: () => listeners.forEach((listener) => listener())
    }
  }
  const mountedEditors: ReturnType<typeof createEditor>[] = []
  return {
    mountedEditors,
    syncWordWrap: vi.fn(() => ({ dispose: vi.fn() })),
    cleanupShiftWheel: vi.fn(),
    createEditor
  }
})

vi.mock('@monaco-editor/react', () => ({
  DiffEditor: ({
    onMount
  }: {
    onMount: (editor: (typeof mountedEditors)[number]['editor']) => void
  }) => {
    const mount = useRef(onMount)
    useEffect(() => {
      const instance = createEditor()
      mountedEditors.push(instance)
      let disposed = false
      // Monaco's React wrapper mounts asynchronously, after the parent's first effect.
      queueMicrotask(() => {
        if (!disposed) {
          mount.current(instance.editor)
        }
      })
      return () => {
        disposed = true
        instance.disposeModified()
      }
    }, [])
    return <div data-testid="monaco-diff" />
  }
}))
vi.mock('./diff-editor-word-wrap-options', () => ({
  buildDiffEditorWordWrapOptions: () => ({}),
  syncDiffEditorOriginalWordWrap: syncWordWrap
}))
vi.mock('./diff-editor-horizontal-wheel-scroll', () => ({
  installDiffEditorHorizontalWheelScroll: () => cleanupShiftWheel
}))
vi.mock('@/i18n/i18n', () => ({ translate: (_key: string, fallback: string) => fallback }))

const props: ComponentProps<typeof DiffSectionBody> = {
  section: {
    key: 'README.md',
    path: 'README.md',
    status: 'M',
    originalContent: 'original',
    modifiedContent: 'modified',
    collapsed: false,
    loading: false,
    dirty: false,
    diffResult: null,
    largeDiffRenderLimit: null
  },
  index: 0,
  sectionBodyHeight: 300,
  useIntrinsicImageHeight: false,
  isBranchMode: false,
  sideBySide: true,
  isDark: false,
  language: 'markdown',
  modelPathBase: 'wrap-lifecycle',
  isEditable: false,
  diffEditorFontSize: 13,
  diffWordWrap: true,
  onRetrySection: vi.fn(),
  onLoadDeferredSection: vi.fn(),
  onSaveLimitedDiff: vi.fn(),
  onMount: vi.fn()
}
const frames = new Map<number, FrameRequestCallback>()

beforeEach(() => {
  mountedEditors.length = 0
  syncWordWrap.mockClear()
  cleanupShiftWheel.mockClear()
  frames.clear()
  let nextFrame = 1
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    const id = nextFrame++
    frames.set(id, callback)
    return id
  })
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frames.delete(id))
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

async function finishMount(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
  })
}
function runMountFrame(): void {
  const queued = [...frames.values()]
  frames.clear()
  act(() => queued.forEach((callback) => callback(0)))
}

describe('combined diff word-wrap lifecycle', () => {
  it('cancels the pending mount frame when the section returns to loading', async () => {
    const view = render(<DiffSectionBody {...props} />)
    await finishMount()
    expect(frames.size).toBe(1)

    view.rerender(<DiffSectionBody {...props} section={{ ...props.section, loading: true }} />)

    expect(frames.size).toBe(0)
    expect(syncWordWrap).not.toHaveBeenCalled()
    expect(cleanupShiftWheel).toHaveBeenCalledOnce()
  })

  it('disposes synchronization and ignores preference changes while the editor is absent', async () => {
    const view = render(<DiffSectionBody {...props} />)
    await finishMount()
    runMountFrame()
    const subscription = syncWordWrap.mock.results[0]?.value
    expect(subscription).toBeDefined()

    view.rerender(<DiffSectionBody {...props} section={{ ...props.section, loading: true }} />)
    expect(subscription?.dispose).toHaveBeenCalledOnce()

    view.rerender(
      <DiffSectionBody
        {...props}
        diffWordWrap={false}
        section={{ ...props.section, loading: true }}
      />
    )
    expect(syncWordWrap).toHaveBeenCalledTimes(1)
  })

  it('uses the current wrap preference when a loading section remounts its editor', async () => {
    const view = render(<DiffSectionBody {...props} />)
    await finishMount()
    runMountFrame()
    const oldEditor = mountedEditors[0]

    view.rerender(
      <DiffSectionBody
        {...props}
        diffWordWrap={false}
        section={{ ...props.section, loading: true }}
      />
    )
    view.rerender(<DiffSectionBody {...props} diffWordWrap={false} />)
    await finishMount()
    expect(frames.size).toBe(1)
    act(() => oldEditor?.disposeModified())
    expect(frames.size).toBe(1)
    runMountFrame()

    expect(syncWordWrap).toHaveBeenLastCalledWith(mountedEditors[1]?.editor, false)
  })
})
