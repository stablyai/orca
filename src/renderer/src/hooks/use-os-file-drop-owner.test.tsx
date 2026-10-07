// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { useRef, useState } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ORCA_INTERNAL_FILE_DRAG_TYPE } from '../../../shared/native-file-drop'
import {
  WORKSPACE_FILE_DRAG_SOURCE_MIME,
  WORKSPACE_FILE_PATHS_MIME
} from '../lib/workspace-file-drag'
import type { PreparedDroppedPaths } from '../../../shared/native-file-drop-preparation'
import { withFallback } from '../web/preload-api/web-fallback-api'
import {
  createOsFileDropSequence,
  useOsFileDropOwner,
  type OsFileDropSequence
} from './use-os-file-drop-owner'

type DropHandler<Destination = undefined> = (
  prepared: PreparedDroppedPaths,
  context: { target: EventTarget | null; destination?: Destination }
) => void | Promise<void>

const getPathForFile = vi.fn((file: File) => `/dropped/${file.name}`)
const prepareDroppedPaths = vi.fn(
  async ({ paths }: { paths: string[] }): Promise<PreparedDroppedPaths> => ({
    paths,
    failures: []
  })
)

function Owner<Destination = undefined>({
  onDrop,
  canAccept,
  sequence,
  captureDestination,
  children
}: {
  onDrop: DropHandler<Destination>
  canAccept?: boolean
  sequence?: OsFileDropSequence
  captureDestination?: (event: DragEvent) => Destination
  children?: React.ReactNode
}): React.JSX.Element {
  const ownerElementRef = useRef<HTMLElement | null>(null)
  const [ownSequence] = useState(createOsFileDropSequence)
  const options = {
    consumer: 'agent' as const,
    onDrop,
    canAccept,
    sequence: sequence ?? ownSequence,
    captureDestination
  }
  const ownerRef = useOsFileDropOwner(ownerElementRef, options)
  return (
    <div ref={ownerRef} data-testid="owner">
      {children}
    </div>
  )
}

function SiblingOwner({
  onDrop,
  titleMounted = true
}: {
  onDrop: DropHandler
  titleMounted?: boolean
}): React.JSX.Element {
  const [sequence] = useState(createOsFileDropSequence)
  return (
    <>
      {titleMounted && <Owner onDrop={onDrop} sequence={sequence} />}
      <Owner onDrop={onDrop} sequence={sequence} />
    </>
  )
}

function drag(
  target: Element,
  type: 'dragover' | 'drop',
  files: File[] = [new File(['a'], 'a.txt')],
  options: { trusted?: boolean; types?: string[] } = {}
): { event: Event; transfer: { dropEffect: string } } {
  const transfer = { types: options.types ?? ['Files'], files, dropEffect: 'move' }
  const event = new Event(type, { bubbles: true, cancelable: true, composed: true })
  Object.defineProperty(event, 'dataTransfer', { value: transfer })
  Object.defineProperty(event, 'isTrusted', { value: options.trusted ?? true })
  act(() => {
    target.dispatchEvent(event)
  })
  return { event, transfer }
}

beforeEach(() => {
  vi.stubGlobal('api', { fs: { getPathForFile, prepareDroppedPaths } })
  getPathForFile.mockClear()
  prepareDroppedPaths.mockClear()
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('useOsFileDropOwner', () => {
  it('registers the root with a callback ref and delivers one prepared drop to the nearest owner', async () => {
    const outerDrop = vi.fn<DropHandler>()
    const innerDrop = vi.fn<DropHandler>()
    const view = render(
      <Owner onDrop={outerDrop}>
        <Owner onDrop={innerDrop}>
          <span data-testid="target" />
        </Owner>
      </Owner>
    )
    const roots = view.getAllByTestId('owner')
    const target = view.getByTestId('target')
    expect(roots.every((root) => root.hasAttribute('data-os-file-drop-owner'))).toBe(true)

    const hover = drag(target, 'dragover')
    expect(hover.event.defaultPrevented).toBe(true)
    expect(hover.transfer.dropEffect).toBe('copy')
    drag(target, 'drop')
    await act(async () => undefined)

    expect(prepareDroppedPaths).toHaveBeenCalledExactlyOnceWith({
      paths: ['/dropped/a.txt'],
      consumer: 'agent'
    })
    expect(innerDrop).toHaveBeenCalledExactlyOnceWith(
      { paths: ['/dropped/a.txt'], failures: [] },
      { target }
    )
    expect(outerDrop).not.toHaveBeenCalled()
    view.unmount()
    expect(roots.every((root) => !root.hasAttribute('data-os-file-drop-owner'))).toBe(true)
  })

  it('keeps a disabled nested owner as a refusal barrier', () => {
    const outerDrop = vi.fn<DropHandler>()
    const innerDrop = vi.fn<DropHandler>()
    const view = render(
      <Owner onDrop={outerDrop}>
        <Owner onDrop={innerDrop} canAccept={false}>
          <span data-testid="target" />
        </Owner>
      </Owner>
    )
    const target = view.getByTestId('target')
    const hover = drag(target, 'dragover')
    expect(hover.transfer.dropEffect).toBe('none')
    drag(target, 'drop')
    expect(outerDrop).not.toHaveBeenCalled()
    expect(innerDrop).not.toHaveBeenCalled()
    expect(getPathForFile).not.toHaveBeenCalled()
  })

  it('caps the file snapshot before resolving any path and reports the local rejection once', async () => {
    const onDrop = vi.fn<DropHandler>()
    const view = render(<Owner onDrop={onDrop} />)
    const files = Array.from({ length: 257 }, (_, index) => new File([], `${index}.txt`))
    drag(view.getByTestId('owner'), 'drop', files)
    await act(async () => undefined)
    expect(getPathForFile).not.toHaveBeenCalled()
    expect(prepareDroppedPaths).not.toHaveBeenCalled()
    expect(onDrop).toHaveBeenCalledOnce()
    expect(onDrop.mock.calls[0][0]).toEqual({
      paths: [],
      failures: [{ target: 'rejected', reason: 'too-many-paths', pathCount: 257, byteLength: 0 }]
    })
  })

  it('reports path byte limits and unresolved files without calling preparation', async () => {
    const onDrop = vi.fn<DropHandler>()
    const view = render(<Owner onDrop={onDrop} />)
    getPathForFile.mockReturnValueOnce('a'.repeat(256 * 1024 + 1))
    drag(view.getByTestId('owner'), 'drop')
    await act(async () => undefined)
    expect(onDrop.mock.calls[0][0].failures[0].reason).toBe('paths-too-large')
    getPathForFile.mockReturnValueOnce('')
    drag(view.getByTestId('owner'), 'drop')
    await act(async () => undefined)
    expect(onDrop.mock.calls[1][0]).toEqual({
      paths: [],
      failures: [{ target: 'rejected', reason: 'unresolved-paths', pathCount: 1, byteLength: 0 }]
    })
    expect(prepareDroppedPaths).not.toHaveBeenCalled()
  })

  it('ignores internal drags and untrusted drops', () => {
    const onDrop = vi.fn<DropHandler>()
    const view = render(<Owner onDrop={onDrop} />)
    const root = view.getByTestId('owner')
    for (const type of [
      ORCA_INTERNAL_FILE_DRAG_TYPE,
      WORKSPACE_FILE_PATHS_MIME,
      WORKSPACE_FILE_DRAG_SOURCE_MIME
    ]) {
      const internal = drag(root, 'drop', undefined, { types: ['Files', type] })
      expect(internal.event.defaultPrevented).toBe(false)
    }
    drag(root, 'drop', undefined, { trusted: false })
    expect(onDrop).not.toHaveBeenCalled()
    expect(prepareDroppedPaths).not.toHaveBeenCalled()
  })

  it.each(['empty', 'throwing'])(
    'keeps resolved paths and reports %s resolutions with preparation failures in order',
    async (resolution) => {
      const onDrop = vi.fn<DropHandler>()
      let finishFirst: ((prepared: PreparedDroppedPaths) => void) | undefined
      prepareDroppedPaths.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishFirst = resolve
          })
      )
      getPathForFile
        .mockReturnValueOnce('/dropped/notes.txt')
        .mockImplementationOnce(() => {
          if (resolution === 'throwing') {
            throw new Error('virtual file has no path')
          }
          return ''
        })
        .mockReturnValueOnce('')
        .mockReturnValueOnce('/dropped/temp.png')
      const view = render(<Owner onDrop={onDrop} />)
      const root = view.getByTestId('owner')
      drag(
        root,
        'drop',
        ['notes.txt', 'virtual.png', 'missing.png', 'temp.png'].map((name) => new File([], name))
      )
      drag(root, 'drop', [new File([], 'later.txt')])
      await act(async () => undefined)
      expect(onDrop).not.toHaveBeenCalled()
      expect(prepareDroppedPaths.mock.calls[0][0]).toEqual({
        paths: ['/dropped/notes.txt', '/dropped/temp.png'],
        consumer: 'agent'
      })
      const copyFailure = {
        target: 'rejected',
        reason: 'temp-copy-failed',
        commonReason: 'copy-failed',
        pathCount: 1,
        byteLength: 0
      } as const
      await act(async () => {
        finishFirst?.({ paths: ['/dropped/notes.txt'], failures: [copyFailure] })
      })
      expect(onDrop).toHaveBeenCalledTimes(2)
      expect(onDrop.mock.calls.map(([prepared]) => prepared)).toEqual([
        {
          paths: ['/dropped/notes.txt'],
          failures: [
            { target: 'rejected', reason: 'unresolved-paths', pathCount: 2, byteLength: 0 },
            copyFailure
          ]
        },
        { paths: ['/dropped/later.txt'], failures: [] }
      ])
    }
  )

  it('reports a preparation failure once without passing unprepared paths', async () => {
    const onDrop = vi.fn<DropHandler>()
    prepareDroppedPaths.mockRejectedValueOnce(new Error('copy failed'))
    const view = render(<Owner onDrop={onDrop} />)
    drag(view.getByTestId('owner'), 'drop')
    await act(async () => undefined)
    expect(onDrop).toHaveBeenCalledOnce()
    expect(onDrop.mock.calls[0][0]).toEqual({
      paths: [],
      failures: [
        {
          target: 'rejected',
          reason: 'temp-copy-failed',
          commonReason: 'copy-failed',
          pathCount: 1,
          byteLength: '/dropped/a.txt'.length
        }
      ]
    })
  })

  it('reports a missing web path bridge to the owner despite fallback method synthesis', async () => {
    const onDrop = vi.fn<DropHandler>()
    vi.stubGlobal('api', withFallback({ fs: { prepareDroppedPaths } }, []))
    const view = render(<Owner onDrop={onDrop} />)
    drag(view.getByTestId('owner'), 'drop')
    await act(async () => undefined)
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      {
        paths: [],
        failures: [{ target: 'rejected', reason: 'unresolved-paths', pathCount: 1, byteLength: 0 }]
      },
      { target: view.getByTestId('owner') }
    )
    expect(getPathForFile).not.toHaveBeenCalled()
    expect(prepareDroppedPaths).not.toHaveBeenCalled()
  })

  it('delivers drops in order within an owner while another owner can finish', async () => {
    const firstDrop = vi.fn<DropHandler>()
    const secondDrop = vi.fn<DropHandler>()
    let finishFirst: ((prepared: PreparedDroppedPaths) => void) | undefined
    prepareDroppedPaths.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishFirst = resolve
        })
    )
    const view = render(
      <>
        <Owner onDrop={firstDrop} />
        <Owner onDrop={secondDrop} />
      </>
    )
    const [firstRoot, secondRoot] = view.getAllByTestId('owner')
    drag(firstRoot, 'drop', [new File([], 'first.txt')])
    drag(firstRoot, 'drop', [new File([], 'later.txt')])
    drag(secondRoot, 'drop', [new File([], 'other.txt')])
    await act(async () => undefined)
    expect(firstDrop).not.toHaveBeenCalled()
    expect(secondDrop).toHaveBeenCalledExactlyOnceWith(
      { paths: ['/dropped/other.txt'], failures: [] },
      { target: secondRoot }
    )

    await act(async () => {
      finishFirst?.({ paths: ['/dropped/first.txt'], failures: [] })
    })
    expect(firstDrop.mock.calls.map(([prepared]) => prepared.paths)).toEqual([
      ['/dropped/first.txt'],
      ['/dropped/later.txt']
    ])
  })

  it('does not deliver a prepared drop after its owner detaches', async () => {
    const onDrop = vi.fn<DropHandler>()
    let finish: ((prepared: PreparedDroppedPaths) => void) | undefined
    prepareDroppedPaths.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const view = render(<Owner onDrop={onDrop} />)
    drag(view.getByTestId('owner'), 'drop')
    view.unmount()
    await act(async () => {
      finish?.({ paths: ['/dropped/a.txt'], failures: [] })
    })
    expect(onDrop).not.toHaveBeenCalled()
  })

  it('orders sibling roots through preparation and asynchronous application while independent owners progress', async () => {
    let finishPreparation: ((prepared: PreparedDroppedPaths) => void) | undefined
    let finishApplication: (() => void) | undefined
    prepareDroppedPaths.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishPreparation = resolve
        })
    )
    const onDrop = vi.fn<DropHandler>().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finishApplication = resolve
        })
    )
    const independentDrop = vi.fn<DropHandler>()
    const view = render(
      <>
        <SiblingOwner onDrop={onDrop} />
        <Owner onDrop={independentDrop} />
      </>
    )
    const [title, content, independent] = view.getAllByTestId('owner')
    drag(title, 'drop', [new File([], 'first.txt')])
    drag(content, 'drop', [new File([], 'second.txt')])
    drag(independent, 'drop', [new File([], 'other.txt')])
    await act(async () => undefined)
    expect(onDrop).not.toHaveBeenCalled()
    expect(independentDrop).toHaveBeenCalledExactlyOnceWith(
      { paths: ['/dropped/other.txt'], failures: [] },
      { target: independent }
    )
    await act(async () => {
      finishPreparation?.({ paths: ['/dropped/first.txt'], failures: [] })
    })
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      { paths: ['/dropped/first.txt'], failures: [] },
      { target: title }
    )
    drag(independent, 'drop', [new File([], 'another.txt')])
    await act(async () => undefined)
    expect(independentDrop).toHaveBeenCalledTimes(2)
    expect(onDrop).toHaveBeenCalledOnce()
    await act(async () => {
      finishApplication?.()
    })
    expect(onDrop.mock.calls.map(([prepared]) => prepared.paths)).toEqual([
      ['/dropped/first.txt'],
      ['/dropped/second.txt']
    ])
  })

  it('suppresses only the detached sibling root and lets its destination sequence continue', async () => {
    let finish: ((prepared: PreparedDroppedPaths) => void) | undefined
    prepareDroppedPaths.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const onDrop = vi.fn<DropHandler>()
    const view = render(<SiblingOwner onDrop={onDrop} />)
    const [title, content] = view.getAllByTestId('owner')
    drag(title, 'drop', [new File([], 'detached.txt')])
    drag(content, 'drop', [new File([], 'kept.txt')])
    view.rerender(<SiblingOwner onDrop={onDrop} titleMounted={false} />)
    await act(async () => undefined)
    expect(onDrop).not.toHaveBeenCalled()
    await act(async () => {
      finish?.({ paths: ['/dropped/detached.txt'], failures: [] })
    })
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      { paths: ['/dropped/kept.txt'], failures: [] },
      { target: content }
    )
  })

  it('captures a destination synchronously before preparation and retains it when the target row recycles', async () => {
    let finish: ((prepared: PreparedDroppedPaths) => void) | undefined
    const captureDestination = vi.fn((event: DragEvent) => {
      expect(prepareDroppedPaths).not.toHaveBeenCalled()
      return event.target instanceof HTMLElement ? (event.target.dataset.folder ?? null) : null
    })
    prepareDroppedPaths.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve
        })
    )
    const onDrop = vi.fn<DropHandler<string | null>>()
    const view = render(
      <Owner onDrop={onDrop} captureDestination={captureDestination}>
        <span data-testid="row" data-folder="original-folder" />
      </Owner>
    )
    const row = view.getByTestId('row')
    drag(row, 'drop')
    expect(captureDestination).toHaveBeenCalledOnce()
    expect(prepareDroppedPaths).toHaveBeenCalledOnce()
    expect(onDrop).not.toHaveBeenCalled()
    row.dataset.folder = 'recycled-folder'
    await act(async () => {
      finish?.({ paths: ['/dropped/a.txt'], failures: [] })
    })
    expect(captureDestination).toHaveBeenCalledOnce()
    expect(onDrop).toHaveBeenCalledExactlyOnceWith(
      { paths: ['/dropped/a.txt'], failures: [] },
      { target: row, destination: 'original-folder' }
    )
  })

  it('reports a callback failure and still delivers the next drop', async () => {
    const reported = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onDrop = vi.fn<DropHandler>()
    onDrop.mockImplementationOnce(() => {
      throw new Error('consumer failed')
    })
    try {
      const view = render(<Owner onDrop={onDrop} />)
      const root = view.getByTestId('owner')
      drag(root, 'drop', [new File([], 'first.txt')])
      drag(root, 'drop', [new File([], 'second.txt')])
      await act(async () => undefined)
      expect(onDrop).toHaveBeenCalledTimes(2)
      expect(reported).toHaveBeenCalledOnce()
      expect(reported.mock.calls[0][1]).toEqual(new Error('consumer failed'))
    } finally {
      reported.mockRestore()
    }
  })
})
