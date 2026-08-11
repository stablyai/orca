// @vitest-environment happy-dom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenFile } from '@/store/slices/editor'

const mocks = vi.hoisted(() => ({
  readRuntimeFileContent: vi.fn(),
  getConnectionIdForFile: vi.fn(),
  getState: vi.fn()
}))

vi.mock('@/runtime/runtime-file-client', () => ({
  readRuntimeFileContent: mocks.readRuntimeFileContent
}))
vi.mock('@/runtime/runtime-rpc-client', () => ({
  settingsForRuntimeOwner: () => null
}))
vi.mock('@/lib/connection-context', () => ({
  getConnectionIdForFile: mocks.getConnectionIdForFile
}))
vi.mock('@/store', () => ({
  useAppStore: { getState: mocks.getState }
}))
// Why: the lazy DiffViewer chunk cannot resolve under happy-dom; a stub that
// echoes its props pins the disk-left/buffer-right wiring instead.
vi.mock('@/lib/lazy-with-retry', () => ({
  lazyWithRetry: () => (props: { originalContent: string; modifiedContent: string }) => (
    <div data-testid="diff-stub">
      original:{props.originalContent}|modified:{props.modifiedContent}
    </div>
  )
}))

import { ExternalFileChangeCompareDialog } from './ExternalFileChangeCompareDialog'

const file = {
  id: 'file-1',
  filePath: '/repo/notes.ts',
  relativePath: 'notes.ts',
  worktreeId: 'wt-1',
  mode: 'edit',
  isDirty: true,
  externalMutation: 'changed'
} as OpenFile

describe('ExternalFileChangeCompareDialog', () => {
  let root: Root | null = null
  let container: HTMLElement | null = null

  beforeEach(() => {
    mocks.readRuntimeFileContent.mockReset()
    mocks.getConnectionIdForFile.mockReset()
    mocks.getConnectionIdForFile.mockReturnValue(undefined)
    mocks.getState.mockReturnValue({ settings: null })
    container = document.createElement('div')
    document.body.appendChild(container)
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    container?.remove()
    document.body.innerHTML = ''
  })

  async function render(element: React.JSX.Element): Promise<void> {
    await act(async () => {
      root = createRoot(container!)
      root.render(element)
    })
  }

  it('shows the disk version left and the buffer right once the read resolves', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'disk version', isBinary: false })

    await render(
      <ExternalFileChangeCompareDialog
        file={file}
        currentContent="buffer version"
        open
        onOpenChange={vi.fn()}
        onReload={vi.fn()}
        onKeepEdits={vi.fn()}
      />
    )

    expect(document.body.textContent).toContain('File changed on disk')
    expect(document.body.textContent).toContain('original:disk version|modified:buffer version')
    expect(document.body.textContent).toContain('Reload from Disk')
    expect(document.body.textContent).toContain('Keep My Edits')
  })

  it('surfaces a read failure instead of a blank comparison', async () => {
    mocks.readRuntimeFileContent.mockRejectedValue(new Error('transport down'))

    await render(
      <ExternalFileChangeCompareDialog
        file={file}
        currentContent="buffer version"
        open
        onOpenChange={vi.fn()}
        onReload={vi.fn()}
        onKeepEdits={vi.fn()}
      />
    )

    expect(document.body.textContent).toContain('Could not read the file from disk')
    expect(document.body.textContent).toContain('transport down')
  })

  it('wires the footer actions and closes the dialog around them', async () => {
    mocks.readRuntimeFileContent.mockResolvedValue({ content: 'disk version', isBinary: false })
    const onReload = vi.fn()
    const onKeepEdits = vi.fn()
    const onOpenChange = vi.fn()

    await render(
      <ExternalFileChangeCompareDialog
        file={file}
        currentContent="buffer version"
        open
        onOpenChange={onOpenChange}
        onReload={onReload}
        onKeepEdits={onKeepEdits}
      />
    )

    const buttons = Array.from(document.body.querySelectorAll('button'))
    await act(async () => {
      buttons.find((b) => b.textContent === 'Reload from Disk')?.click()
    })
    expect(onOpenChange).toHaveBeenCalledWith(false)
    expect(onReload).toHaveBeenCalledTimes(1)

    await act(async () => {
      buttons.find((b) => b.textContent === 'Keep My Edits')?.click()
    })
    expect(onKeepEdits).toHaveBeenCalledTimes(1)
  })
})
