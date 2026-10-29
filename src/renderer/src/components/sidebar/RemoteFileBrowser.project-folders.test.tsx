// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import type { Repo } from '../../../../shared/repo-types'
import { RemoteFileBrowser } from './RemoteFileBrowser'

const browseDir = vi.fn(async ({ dirPath }: { dirPath: string }) => ({
  entries: [
    { name: 'docs', isDirectory: true },
    { name: 'src', isDirectory: true }
  ],
  resolvedPath: dirPath === '~' ? '/home/alice' : dirPath,
  pathFlavor: 'posix' as const
}))

function repo(id: string, path: string, executionHostId: Repo['executionHostId']): Repo {
  return { id, path, displayName: id, badgeColor: '#000', addedAt: 1, executionHostId }
}

const REPOS = [
  repo('orca', '/home/alice/code/orca', 'ssh:target-1'),
  repo('site', '/home/alice/code/site', 'ssh:target-1'),
  repo('api', '/srv/app/api', 'ssh:target-1'),
  repo('elsewhere', '/opt/other/tool', 'ssh:target-2'),
  repo('local', '/Users/alice/notes', 'local')
]

async function flushPromises(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await Promise.resolve()
  }
}

async function render(
  onSelect = vi.fn(),
  initialPath?: string
): Promise<{
  container: HTMLDivElement
  input: HTMLInputElement
  root: Root
}> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  await act(async () => {
    root.render(
      <RemoteFileBrowser
        targetId="target-1"
        initialPath={initialPath}
        onSelect={onSelect}
        onCancel={vi.fn()}
      />
    )
    await flushPromises()
  })
  const input = container.querySelector('input')
  if (!input) {
    throw new Error('Remote file browser input was not rendered')
  }
  return { container, input, root }
}

async function press(
  input: HTMLInputElement,
  key: string,
  modifiers: KeyboardEventInit = {}
): Promise<void> {
  await act(async () => {
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...modifiers })
    )
    await flushPromises()
  })
}

function projectFolderRows(container: HTMLElement): (string | null)[] {
  return [...container.querySelectorAll('[role="group"] [role="option"]')].map(
    (row) => row.textContent
  )
}

function selectedRow(container: HTMLElement): string | null | undefined {
  return container.querySelector('[role="option"][aria-selected="true"]')?.textContent
}

describe('RemoteFileBrowser project folders', () => {
  beforeEach(() => {
    globalThis.IS_REACT_ACT_ENVIRONMENT = true
    browseDir.mockClear()
    Object.defineProperty(window, 'api', { configurable: true, value: { ssh: { browseDir } } })
    useAppStore.setState({ repos: REPOS })
  })

  afterEach(() => {
    vi.useRealTimers()
    useAppStore.setState({ repos: [] })
    document.body.replaceChildren()
    vi.restoreAllMocks()
  })

  it("lists this host's project folders above the entries and opens one from the keyboard", async () => {
    const { container, input, root } = await render()
    // Paths under the host's home read as `~/…` so a truncated row keeps its tail.
    expect(projectFolderRows(container)).toEqual(['~/code', '/srv/app'])
    // Enter keeps its default target: the first entry, not a folder row.
    expect(selectedRow(container)).toBe('docs')

    await press(input, 'ArrowUp')
    expect(selectedRow(container)).toBe('/srv/app')
    expect(input.getAttribute('aria-activedescendant')).toBe(
      container.querySelector('[role="option"][aria-selected="true"]')?.id
    )

    browseDir.mockClear()
    await press(input, 'Enter')
    expect(browseDir).toHaveBeenCalledWith({ targetId: 'target-1', dirPath: '/srv/app' })
    // The folder being shown is not offered as a jump target.
    expect(projectFolderRows(container)).toEqual(['~/code'])
    await act(async () => root.unmount())
  })

  // Why: catalog refreshes replace repo rows with equal copies; the moved highlight must survive them.
  it('shortens home paths even when the browser opens away from home', async () => {
    const { container, root } = await render(vi.fn(), '/srv')
    expect(projectFolderRows(container)).toEqual(['~/code', '/srv/app'])
    await act(async () => root.unmount())
  })

  it('opens the highlighted folder on Enter with a modifier too', async () => {
    const { input, root } = await render()
    await press(input, 'ArrowUp')
    browseDir.mockClear()

    await press(input, 'Enter', { shiftKey: true })
    expect(browseDir).toHaveBeenCalledWith({ targetId: 'target-1', dirPath: '/srv/app' })
    await act(async () => root.unmount())
  })

  it('keeps the highlighted folder when projects refresh with the same paths', async () => {
    const { container, input, root } = await render()
    await press(input, 'ArrowUp')
    expect(selectedRow(container)).toBe('/srv/app')

    await act(async () => {
      useAppStore.setState({ repos: REPOS.map((entry) => ({ ...entry })) })
    })
    expect(selectedRow(container)).toBe('/srv/app')
    await act(async () => root.unmount())
  })

  it('selects a project folder on double click and hides the folders while filtering', async () => {
    const onSelect = vi.fn()
    const { container, input, root } = await render(onSelect)
    const folderRow = container.querySelector<HTMLElement>('[role="group"] [role="option"]')
    await act(async () => {
      folderRow?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    })
    expect(onSelect).toHaveBeenCalledWith('/home/alice/code')

    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(input, 'do')
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    expect(projectFolderRows(container)).toEqual([])
    expect(selectedRow(container)).toBe('docs')
    await act(async () => root.unmount())
  })
})
