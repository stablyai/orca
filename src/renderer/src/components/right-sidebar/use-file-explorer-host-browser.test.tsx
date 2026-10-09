// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HostDirectoryListing } from '../../../../shared/filesystem-entry-types'
import type * as HostModeModule from './file-explorer-host-mode'
import type { HostBrowseSource } from './file-explorer-host-mode'
import {
  useFileExplorerHostBrowser,
  type FileExplorerHostBrowser
} from './use-file-explorer-host-browser'

const { fetchListingMock, resolveEntryMock, openHostFileMock } = vi.hoisted(() => ({
  fetchListingMock: vi.fn(),
  resolveEntryMock: vi.fn(),
  openHostFileMock: vi.fn()
}))

vi.mock('./file-explorer-host-mode', async (importOriginal) => ({
  ...(await importOriginal<typeof HostModeModule>()),
  fetchHostDirectoryListing: fetchListingMock,
  resolveHostEntry: resolveEntryMock
}))
vi.mock('./file-explorer-host-open', () => ({ openHostFile: openHostFileMock }))
const { toastErrorMock } = vi.hoisted(() => ({ toastErrorMock: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: toastErrorMock } }))

function listingFor(path: string, flavor: 'posix' | 'win32' = 'posix'): HostDirectoryListing {
  return { resolvedPath: path, entries: [], pathFlavor: flavor }
}

async function flush(): Promise<void> {
  for (let i = 0; i < 6; i += 1) {
    await Promise.resolve()
  }
}

type Props = {
  active: boolean
  visit?: string
  source?: HostBrowseSource | null
  worktreePath?: string
}

const local: HostBrowseSource = { kind: 'local' }

let root: Root
let latest: FileExplorerHostBrowser

function Harness(props: Props): null {
  const { active, visit = '1', source = local, worktreePath = '/home/allen/codes' } = props
  latest = useFileExplorerHostBrowser({
    source,
    worktreePath,
    visitKey: active ? visit : null,
    worktreeId: 'wt-1'
  })
  return null
}

async function render(props: Props): Promise<void> {
  await act(async () => {
    root.render(<Harness {...props} />)
    await flush()
  })
}

async function run(action: () => void): Promise<void> {
  await act(async () => {
    action()
    await flush()
  })
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  fetchListingMock.mockReset()
  fetchListingMock.mockImplementation(async (_source: HostBrowseSource, path: string) =>
    listingFor(path, /^[A-Z]:/.test(path) ? 'win32' : 'posix')
  )
  resolveEntryMock.mockReset()
  openHostFileMock.mockReset()
  root = createRoot(document.createElement('div'))
})

afterEach(() => {
  act(() => root.unmount())
})

describe('useFileExplorerHostBrowser', () => {
  it('stays idle in Project mode', async () => {
    await render({ active: false })

    expect(fetchListingMock).not.toHaveBeenCalled()
    expect(latest.listing).toBeNull()
    expect(latest.canNavigateUp).toBe(false)
  })

  it('navigates to breadcrumb targets and cannot climb above /', async () => {
    await render({ active: true })

    await run(() => latest.navigate('/'))
    expect(latest.listing?.resolvedPath).toBe('/')
    expect(latest.canNavigateUp).toBe(false)

    const calls = fetchListingMock.mock.calls.length
    await run(() => latest.navigateUp())
    expect(fetchListingMock.mock.calls.length).toBe(calls)
  })

  it('walks Windows paths up to the drive root, then the drive list', async () => {
    await render({ active: true, worktreePath: 'C:\\Users\\allen\\codes' })

    await run(() => latest.navigateUp())
    expect(latest.listing?.resolvedPath).toBe('C:\\Users\\allen')

    await run(() => latest.navigate('C:\\'))
    await run(() => latest.navigateUp())
    expect(fetchListingMock).toHaveBeenLastCalledWith(local, '/')
  })

  it('browses sibling folders on an SSH host', async () => {
    const ssh: HostBrowseSource = { kind: 'ssh', connectionId: 'ssh-1' }
    await render({ active: true, source: ssh, worktreePath: '/Data2/allen921103/project' })

    await run(() => latest.navigateUp())
    resolveEntryMock.mockResolvedValueOnce({
      kind: 'directory',
      realPath: '/Data2/allen921103/other',
      workspaceRelativePath: null
    })
    await run(() => latest.activateEntry({ name: 'other', isDirectory: true, isSymlink: false }))

    expect(fetchListingMock).toHaveBeenLastCalledWith(ssh, '/Data2/allen921103/other')
  })

  it('ignores a slow listing that a newer navigation superseded', async () => {
    await render({ active: true })
    const slow = Promise.withResolvers<HostDirectoryListing>()
    fetchListingMock.mockImplementationOnce(() => slow.promise)

    await run(() => latest.navigate('/slow'))
    await run(() => latest.navigate('/fast'))
    await run(() => slow.resolve(listingFor('/slow')))

    expect(latest.listing?.resolvedPath).toBe('/fast')
  })

  it('follows symlinked directories and opens resolved files', async () => {
    await render({ active: true })
    await run(() => latest.navigateUp())

    resolveEntryMock.mockResolvedValueOnce({
      kind: 'directory',
      realPath: '/mnt/data',
      workspaceRelativePath: null
    })
    await run(() => latest.activateEntry({ name: 'data', isDirectory: false, isSymlink: true }))
    expect(fetchListingMock).toHaveBeenLastCalledWith(local, '/home/allen/data')

    resolveEntryMock.mockResolvedValueOnce({
      kind: 'file',
      realPath: '/home/allen/data/x.txt',
      workspaceRelativePath: null
    })
    await run(() => latest.activateEntry({ name: 'x.txt', isDirectory: false, isSymlink: false }))
    expect(openHostFileMock).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: { kind: 'external', filePath: '/home/allen/data/x.txt' },
        worktreeId: 'wt-1'
      })
    )
  })

  it('starts each new visit at the workspace root', async () => {
    await render({ active: true, visit: '1' })
    await run(() => latest.navigateUp())

    await render({ active: false, visit: '1' })
    expect(latest.listing).toBeNull()

    await render({ active: true, visit: '2' })
    expect(latest.listing?.resolvedPath).toBe('/home/allen/codes')
  })

  it.each([
    {
      name: 'the user navigates elsewhere',
      entry: { name: 'link', isDirectory: false, isSymlink: true },
      interrupt: () => run(() => latest.navigate('/var')),
      after: () => expect(latest.listing?.resolvedPath, 'the new folder stays shown').toBe('/var')
    },
    {
      name: 'the visit ends',
      entry: { name: 'notes.md', isDirectory: false, isSymlink: false },
      interrupt: () => render({ active: false })
    }
  ])('drops a slow click resolution once $name', async ({ entry, interrupt, after }) => {
    await render({ active: true })
    const click = Promise.withResolvers<unknown>()
    resolveEntryMock.mockImplementationOnce(() => click.promise)

    await run(() => latest.activateEntry(entry))
    await interrupt()
    await run(() =>
      click.resolve({
        kind: 'file',
        realPath: `/home/allen/codes/${entry.name}`,
        workspaceRelativePath: null
      })
    )

    after?.()
    expect(openHostFileMock).not.toHaveBeenCalled()
  })

  it('stays on the current folder when a folder cannot be opened', async () => {
    await render({ active: true })
    fetchListingMock.mockRejectedValueOnce(new Error('EACCES: permission denied'))

    await run(() => latest.navigate('/root'))

    expect(latest.error).toBeNull()
    expect(latest.loading).toBe(false)
    expect(latest.listing?.resolvedPath).toBe('/home/allen/codes')
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
    await run(() => latest.navigateUp())
    expect(latest.listing?.resolvedPath).toBe('/home/allen')
    expect(fetchListingMock, 'navigateUp lists the parent folder').toHaveBeenLastCalledWith(
      local,
      '/home/allen'
    )
  })

  it('shows a full error only when the first Host listing fails', async () => {
    fetchListingMock.mockRejectedValueOnce(new Error('connection lost'))

    await render({ active: true })

    expect(latest.listing).toBeNull()
    expect(latest.error).toMatch(/connection lost/)
  })

  it('keeps the spinner hidden for fast listings and shows it for slow ones', async () => {
    vi.useFakeTimers()
    try {
      await render({ active: true })
      fetchListingMock.mockImplementationOnce(() => new Promise<HostDirectoryListing>(() => {}))

      await run(() => latest.navigate('/slow'))
      expect(latest.loading).toBe(true)
      expect(latest.showLoading).toBe(false)

      await act(async () => {
        vi.advanceTimersByTime(250)
      })
      expect(latest.showLoading).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps a shown spinner visible for the minimum hold after the listing lands', async () => {
    vi.useFakeTimers()
    try {
      await render({ active: true })
      let resolveListing: (listing: HostDirectoryListing) => void = () => {}
      fetchListingMock.mockImplementationOnce(
        () => new Promise<HostDirectoryListing>((resolve) => (resolveListing = resolve))
      )

      await run(() => latest.navigate('/slow'))
      await act(async () => {
        vi.advanceTimersByTime(250)
      })
      expect(latest.showLoading).toBe(true)

      await act(async () => {
        resolveListing(listingFor('/slow'))
      })
      expect(latest.loading).toBe(false)
      expect(latest.showLoading).toBe(true)

      await act(async () => {
        vi.advanceTimersByTime(400)
      })
      expect(latest.showLoading).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })
})
