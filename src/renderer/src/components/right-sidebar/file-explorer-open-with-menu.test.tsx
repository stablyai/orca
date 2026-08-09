// @vitest-environment happy-dom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from '@/components/ui/context-menu'
import { FileExplorerOpenWithMenu } from './FileExplorerOpenWithMenu'
import type { OpenWithApplication } from '../../../../shared/types'

const preview: OpenWithApplication = {
  id: 'app-preview',
  label: 'Preview',
  command: `open -a '/Applications/Preview.app'`,
  applicationPath: '/Applications/Preview.app'
}

const mocks = vi.hoisted(() => ({
  openInExternalEditor: vi.fn(),
  openFilePath: vi.fn(),
  pickApplication: vi.fn(),
  updateSettings: vi.fn().mockResolvedValue(undefined),
  state: {
    keybindings: {},
    settings: {
      activeRuntimeEnvironmentId: null as string | null,
      openWithApplications: [] as OpenWithApplication[],
      openWithDefaults: {} as Record<string, string>,
      openInApplications: [{ id: 'vscode', label: 'VS Code', command: 'code' }]
    },
    repos: [{ id: 'repo-1', connectionId: null as string | null }],
    worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1' }] },
    activeWorktreeId: 'wt-1' as string | null,
    updateSettings: vi.fn()
  }
}))

vi.mock('@/store', () => {
  const useAppStore = (selector: (state: typeof mocks.state) => unknown): unknown =>
    selector(mocks.state)
  useAppStore.getState = (): typeof mocks.state => mocks.state
  return { useAppStore }
})

vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))

async function openSubmenu(path = '/repo/a.png'): Promise<void> {
  render(
    <ContextMenu>
      <ContextMenuTrigger>
        <button type="button">row</button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <FileExplorerOpenWithMenu path={path} connectionId={null} />
      </ContextMenuContent>
    </ContextMenu>
  )
  fireEvent.contextMenu(screen.getByRole('button', { name: 'row' }))
  fireEvent.click(await screen.findByText('Open With'))
}

beforeEach(() => {
  mocks.openInExternalEditor.mockReset().mockResolvedValue({ ok: true })
  mocks.openFilePath.mockReset().mockResolvedValue(true)
  mocks.pickApplication.mockReset().mockResolvedValue(null)
  mocks.state.settings = {
    activeRuntimeEnvironmentId: null,
    openWithApplications: [preview],
    openWithDefaults: { '.png': 'app-preview' },
    openInApplications: [{ id: 'vscode', label: 'VS Code', command: 'code' }]
  }
  mocks.state.updateSettings = mocks.updateSettings
  ;(globalThis as unknown as { window: { api: unknown } }).window.api = {
    shell: {
      openInExternalEditor: mocks.openInExternalEditor,
      openFilePath: mocks.openFilePath,
      pickApplication: mocks.pickApplication
    }
  }
})

afterEach(() => {
  // Why: Radix parks a dismissable layer on document while the menu is open;
  // unmounting without closing leaks it and the next test's menu never opens.
  fireEvent.keyDown(document, { key: 'Escape' })
  cleanup()
})

describe('FileExplorerOpenWithMenu', () => {
  it('lists registered apps with the Open in editors and launches the chosen one', async () => {
    await openSubmenu()

    const previewItem = await screen.findByText('Preview')
    expect(screen.getByText('VS Code')).toBeTruthy()
    expect(screen.getByText('System Default App')).toBeTruthy()

    fireEvent.click(previewItem)

    expect(mocks.openInExternalEditor).toHaveBeenCalledWith({
      path: '/repo/a.png',
      command: preview.command,
      connectionId: null
    })
  })
})
