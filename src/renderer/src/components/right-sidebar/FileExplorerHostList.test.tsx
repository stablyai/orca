// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { DirEntry } from '../../../../shared/filesystem-entry-types'
import { FileExplorerHostList } from './FileExplorerHostList'
import { shouldIgnoreFileExplorerKeyTarget } from './useFileExplorerKeys'
import type { FileExplorerHostMode } from './use-file-explorer-host-mode'

let root: Root
let container: HTMLDivElement

function hostMode(entries: DirEntry[], overrides: Partial<FileExplorerHostMode['browser']> = {}) {
  const browser = {
    listing: { resolvedPath: '/home/allen', entries, pathFlavor: 'posix' as const },
    loading: false,
    error: null,
    canNavigateUp: true,
    navigate: vi.fn(),
    navigateUp: vi.fn(),
    refresh: vi.fn(),
    activateEntry: vi.fn(),
    ...overrides
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the list reads only `browser` and `filterQuery`.
  return { browser, filterQuery: '' } as unknown as FileExplorerHostMode
}

async function render(mode: FileExplorerHostMode, showDotfiles = true): Promise<void> {
  await act(async () => {
    root.render(<FileExplorerHostList hostMode={mode} showDotfiles={showDotfiles} />)
  })
}

function rowLabels(): string[] {
  return [...container.querySelectorAll('button')].map((button) => button.textContent ?? '')
}

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  document.body.replaceChildren()
})

const codes = { name: 'codes', isDirectory: true, isSymlink: false }
const documents = { name: 'Documents', isDirectory: true, isSymlink: false }
const bashrc = { name: '.bashrc', isDirectory: false, isSymlink: false }

describe('FileExplorerHostList', () => {
  it('lists a Parent row above sibling folders and activates entries', async () => {
    const mode = hostMode([codes, documents, bashrc])
    await render(mode)

    expect(rowLabels()).toEqual(['Parent directory', 'codes', 'Documents', '.bashrc'])
    act(() => container.querySelectorAll('button')[0]?.click())
    act(() => container.querySelectorAll('button')[2]?.click())
    expect(mode.browser.navigateUp).toHaveBeenCalledTimes(1)
    expect(mode.browser.activateEntry).toHaveBeenCalledWith(documents)
  })

  it('omits the Parent row at a filesystem root and hides dotfiles when asked', async () => {
    await render(hostMode([codes, bashrc], { canNavigateUp: false }), false)

    expect(rowLabels()).toEqual(['codes'])
  })

  it('keeps tree shortcuts from acting on the hidden tree selection', async () => {
    await render(hostMode([codes]))

    const row = container.querySelectorAll('button')[1]
    expect(shouldIgnoreFileExplorerKeyTarget(row ?? null)).toBe(true)
  })

  it('mounts only a window of rows for very large folders', async () => {
    const many = Array.from({ length: 5_000 }, (_, index) => ({
      name: `f${index}`,
      isDirectory: false,
      isSymlink: false
    }))
    await render(hostMode(many))

    const mounted = container.querySelectorAll('[data-file-explorer-host-list] button').length
    expect(container.querySelector('[data-testid="virtualized-list"]')).not.toBeNull()
    expect(mounted).toBeGreaterThan(0)
    expect(mounted).toBeLessThan(200)
  })

  it('dims the folder on screen while a slow navigation is pending', async () => {
    await render(hostMode([codes], { showLoading: true }))
    expect(container.querySelector('[data-file-explorer-host-list]')?.className).toContain(
      'opacity-60'
    )

    await render(hostMode([codes], { showLoading: false }))
    expect(container.querySelector('[data-file-explorer-host-list]')?.className).not.toContain(
      'opacity-60'
    )
  })

  it('starts a new folder or filter at the top but keeps the place on revalidation', async () => {
    const at = (
      path: string,
      entries: DirEntry[],
      filterQuery = '',
      error: string | null = null
    ) => {
      const mode = hostMode(entries, {
        listing: { resolvedPath: path, entries, pathFlavor: 'posix' as const },
        error
      })
      return { ...mode, filterQuery }
    }
    const scroller = () => container.querySelector<HTMLElement>('[data-file-explorer-host-list]')
    const scrollTo = (top: number) => {
      const el = scroller()
      if (el) {
        el.scrollTop = top
      }
    }

    await render(at('/home/allen', [codes, documents]))
    scrollTo(500)
    await render(at('/home/allen', [codes, documents, bashrc]))
    expect(scroller()?.scrollTop).toBe(500)

    await render(at('/home/allen', [codes, documents, bashrc]))
    expect(scroller()?.scrollTop).toBe(500)

    await render(at('/home/allen/Documents', [bashrc]))
    expect(scroller()?.scrollTop).toBe(0)

    scrollTo(500)
    await render(at('/home/allen/Documents', [bashrc], 'bash'))
    expect(scroller()?.scrollTop).toBe(0)
  })
})
