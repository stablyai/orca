// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { RemoteFileBrowser } from './RemoteFileBrowser'

const browseDir = vi.fn(async ({ dirPath }: { dirPath: string; targetId: string }) => ({
  entries: [
    { name: 'linked-dir', isDirectory: true, isSymlink: true },
    { name: 'real-dir', isDirectory: true, isSymlink: false },
    { name: 'linked-file', isDirectory: false, isSymlink: true },
    { name: 'README.md', isDirectory: false, isSymlink: false }
  ],
  resolvedPath: dirPath === '~' ? '/home/alice' : dirPath
}))

async function flushPromises(count = 4): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await Promise.resolve()
  }
}

describe('RemoteFileBrowser symlink indicator', () => {
  let container: HTMLDivElement
  let root: Root

  beforeEach(() => {
    ;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true
    browseDir.mockClear()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: {
        ssh: {
          browseDir
        }
      }
    })
  })

  afterEach(() => {
    act(() => {
      root.unmount()
    })
    container.remove()
  })

  it('marks symlinked entries with a link indicator', async () => {
    container = document.createElement('div')
    document.body.appendChild(container)
    root = createRoot(container)

    await act(async () => {
      root.render(<RemoteFileBrowser targetId="target-1" onSelect={vi.fn()} onCancel={vi.fn()} />)
      await flushPromises()
    })

    const rows = [...container.querySelectorAll('button')].filter((button) =>
      ['linked-dir', 'real-dir', 'linked-file', 'README.md'].includes(
        button.textContent?.trim() ?? ''
      )
    )
    expect(rows).toHaveLength(4)

    const rowsWithIndicator = rows
      .filter((row) => row.querySelector('[aria-label="Symbolic link"]'))
      .map((row) => row.textContent?.trim())
    expect(rowsWithIndicator).toEqual(['linked-dir', 'linked-file'])
  })
})
