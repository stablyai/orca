import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import {
  getWorktreeOpenInEntries,
  getOpenInEntryAvailability,
  getLocalFileManagerLabel,
  openOpenInAppsSettings,
  openWorktreePath,
  WorktreeOpenInSubMenu
} from './WorktreeOpenInMenu'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const {
  mockState,
  openInExternalEditorMock,
  openInFileManagerMock,
  openSettingsPageMock,
  openSettingsTargetMock,
  toastErrorMock
} = vi.hoisted(() => ({
  mockState: {
    settings: {
      activeRuntimeEnvironmentId: null as string | null,
      openInApplications: [] as { id: string; label: string; command: string }[]
    }
  },
  openInExternalEditorMock: vi.fn(),
  openInFileManagerMock: vi.fn(),
  openSettingsPageMock: vi.fn(),
  openSettingsTargetMock: vi.fn(),
  toastErrorMock: vi.fn()
}))

vi.mock('sonner', () => ({
  toast: {
    error: toastErrorMock
  }
}))

vi.mock('@/store', () => {
  const useAppStore = Object.assign(
    (selector: (state: { settings: typeof mockState.settings }) => unknown) =>
      selector({ settings: mockState.settings }),
    {
      getState: () => ({
        settings: mockState.settings,
        openSettingsPage: openSettingsPageMock,
        openSettingsTarget: openSettingsTargetMock
      })
    }
  )
  return { useAppStore }
})

function visit(node: unknown, cb: (node: ReactElementLike) => void): void {
  if (node == null || typeof node === 'string' || typeof node === 'number') {
    return
  }
  if (Array.isArray(node)) {
    node.forEach((entry) => visit(entry, cb))
    return
  }
  const element = node as ReactElementLike
  cb(element)
  if (element.props?.children) {
    visit(element.props.children, cb)
  }
}

function findByType(node: unknown, type: unknown): ReactElementLike {
  let found: ReactElementLike | null = null
  visit(node, (entry) => {
    if (entry.type === type) {
      found = entry
    }
  })
  if (!found) {
    throw new Error('element not found')
  }
  return found
}

describe('WorktreeOpenInMenu', () => {
  beforeEach(() => {
    mockState.settings = { activeRuntimeEnvironmentId: null, openInApplications: [] }
    toastErrorMock.mockReset()
    openInFileManagerMock.mockReset()
    openInExternalEditorMock.mockReset()
    openSettingsPageMock.mockReset()
    openSettingsTargetMock.mockReset()
    openInFileManagerMock.mockResolvedValue({ ok: true })
    openInExternalEditorMock.mockResolvedValue({ ok: true })
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        api: {
          shell: {
            openInFileManager: openInFileManagerMock,
            openInExternalEditor: openInExternalEditorMock
          }
        }
      }
    })
  })

  it('maps file manager labels by platform', () => {
    expect(getLocalFileManagerLabel('Mozilla/5.0 Mac OS X')).toBe('Finder')
    expect(getLocalFileManagerLabel('Mozilla/5.0 Windows NT 10.0')).toBe('File Explorer')
    expect(getLocalFileManagerLabel('Mozilla/5.0 X11 Linux x86_64')).toBe('File Manager')
  })

  it('disables the Open in submenu while deleting', () => {
    const tree = WorktreeOpenInSubMenu({
      worktreePath: '/tmp/workspace',
      connectionId: null,
      disabled: true
    })

    expect(findByType(tree, DropdownMenuSubTrigger).props.disabled).toBe(true)
  })

  it('stops menu item click propagation', () => {
    const tree = WorktreeOpenInSubMenu({
      worktreePath: '/tmp/workspace',
      connectionId: null
    })
    const menuContent = findByType(tree, DropdownMenuSubContent)

    const stopPropagation = vi.fn()
    const handler = menuContent.props.onClick as ((event: React.SyntheticEvent) => void) | null
    handler?.({ stopPropagation } as unknown as React.SyntheticEvent)
    expect(stopPropagation).toHaveBeenCalled()
  })

  it('uses the blocked-path toast without calling main IPC', async () => {
    await openWorktreePath({
      target: 'file-manager',
      worktreePath: '/tmp/workspace',
      connectionId: 'ssh-1'
    })

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
    expect(openInFileManagerMock).not.toHaveBeenCalled()
    expect(openInExternalEditorMock).not.toHaveBeenCalled()
  })

  it('shows an actionable toast when the host launcher fails', async () => {
    openInExternalEditorMock.mockResolvedValueOnce({ ok: false, reason: 'launch-failed' })

    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/tmp/workspace',
      connectionId: null
    })

    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/tmp/workspace',
      command: undefined,
      connectionId: null,
      ownerHostId: 'local'
    })
    expect(toastErrorMock).toHaveBeenCalledWith('Could not open workspace folder.', {
      description: 'Check the editor command or file manager configuration on this machine.'
    })
  })

  it('opens a local workspace while a server is focused', async () => {
    mockState.settings = { activeRuntimeEnvironmentId: 'runtime-1', openInApplications: [] }
    const fileManager = { id: 'file-manager', label: 'Finder', target: 'file-manager' } as const
    expect(getOpenInEntryAvailability(fileManager, null, null)).toEqual({ disabled: false })

    await openWorktreePath({ target: 'file-manager', worktreePath: '/tmp/workspace' })
    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/tmp/workspace',
      command: 'cursor'
    })

    expect(openInFileManagerMock).toHaveBeenCalledWith('/tmp/workspace', 'local')
    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/tmp/workspace',
      command: 'cursor',
      connectionId: undefined,
      ownerHostId: 'local'
    })
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('builds menu entries from configured launchers with file manager last', () => {
    expect(
      getWorktreeOpenInEntries(
        [
          { id: 'vscode', label: 'VS Code', command: 'code' },
          { id: 'cursor', label: 'Cursor', command: 'cursor' },
          { id: 'zed', label: 'Zed', command: 'zed' }
        ],
        'File Manager'
      ).map((entry) => entry.label)
    ).toEqual(['VS Code', 'Cursor', 'Zed', 'File Manager'])
  })

  it('opens settings at the Open In Apps section', () => {
    openOpenInAppsSettings()

    expect(openSettingsTargetMock).toHaveBeenCalledWith({
      pane: 'general',
      repoId: null,
      sectionId: 'general-open-in-apps'
    })
    expect(openSettingsPageMock).toHaveBeenCalled()
  })

  it('forwards the configured command when opening a configured launcher', async () => {
    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/tmp/workspace',
      connectionId: null,
      command: 'cursor'
    })
    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/tmp/workspace',
      command: 'cursor',
      connectionId: null,
      ownerHostId: 'local'
    })
  })

  it('blocks configured launchers in remote context before calling main IPC', async () => {
    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/tmp/workspace',
      connectionId: null,
      runtimeEnvironmentId: 'runtime-1',
      command: 'cursor'
    })

    expect(openInExternalEditorMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith(
      'Opening this path in a local app is not available.',
      { description: 'Switch to a local or SSH workspace, then try again.' }
    )
  })

  it('enables only VS Code-compatible launchers for SSH paths', () => {
    const entries = getWorktreeOpenInEntries(
      [
        { id: 'renamed', label: 'My Remote Editor', command: 'code-insiders' },
        { id: 'fake', label: 'VS Code', command: 'cursor' },
        { id: 'compound', label: 'VS Code Reuse', command: 'code --reuse-window' }
      ],
      'Finder'
    )

    expect(getOpenInEntryAvailability(entries[0], 'ssh-1')).toEqual({
      disabled: false,
      metadata: 'Remote SSH'
    })
    expect(getOpenInEntryAvailability(entries[1], 'ssh-1')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
    expect(getOpenInEntryAvailability(entries[2], 'ssh-1')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
    expect(getOpenInEntryAvailability(entries[3], 'ssh-1')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
  })

  it('forwards SSH context for a supported VS Code launcher', async () => {
    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/home/ada/project',
      connectionId: 'ssh-1',
      command: 'code'
    })

    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/home/ada/project',
      command: 'code',
      connectionId: 'ssh-1',
      ownerHostId: 'ssh:ssh-1'
    })
  })

  it('blocks SSH local-only launchers before IPC with actionable copy', async () => {
    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/home/ada/project',
      connectionId: 'ssh-1',
      command: 'cursor'
    })

    expect(openInExternalEditorMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith('This app cannot open SSH workspaces.', {
      description: 'Choose VS Code or use the app locally.'
    })
  })

  it('shows the SSH alias recovery details returned by main', async () => {
    openInExternalEditorMock.mockResolvedValueOnce({
      ok: false,
      reason: 'ssh-alias-required',
      host: 'builder.example.com',
      port: 2222
    })

    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/srv/project',
      connectionId: 'ssh-1',
      command: 'code'
    })

    expect(toastErrorMock).toHaveBeenCalledWith(
      'VS Code needs an SSH config alias for this host.',
      {
        description:
          'Add a Host alias for builder.example.com:2222 to your local SSH config, reconnect the workspace, then try again.'
      }
    )
  })
  it.each(['file-manager', 'external-editor'] as const)(
    'blocks a %s click for an owner other than the focused desktop',
    async (target) => {
      await openWorktreePath({
        target,
        worktreePath: '/same/path',
        command: 'zed',
        runtimeEnvironmentId: 'managed-owner'
      })
      expect(openInFileManagerMock).not.toHaveBeenCalled()
      expect(openInExternalEditorMock).not.toHaveBeenCalled()
      expect(toastErrorMock).toHaveBeenCalled()
    }
  )

  it('marks a managed owner local-only in the menu with a locally focused desktop', () => {
    const entry = { id: 'zed', label: 'Zed', target: 'external-editor', command: 'zed' } as const
    expect(getOpenInEntryAvailability(entry, null, 'managed-owner')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
  })

  it('marks an unresolved owner local-only and never launches the desktop copy', async () => {
    const editor = { id: 'zed', label: 'Zed', target: 'external-editor', command: 'zed' } as const
    const fileManager = { id: 'file-manager', label: 'Finder', target: 'file-manager' } as const
    for (const entry of [editor, fileManager]) {
      expect(getOpenInEntryAvailability(entry, null, null, true)).toEqual({
        disabled: true,
        metadata: 'Local only'
      })
    }
    for (const target of ['external-editor', 'file-manager'] as const) {
      await openWorktreePath({
        target,
        worktreePath: '/srv/worktree',
        connectionId: 'ssh-1',
        runtimeEnvironmentId: null,
        ownerUnresolved: true,
        command: 'code'
      })
    }
    expect(openInExternalEditorMock).not.toHaveBeenCalled()
    expect(openInFileManagerMock).not.toHaveBeenCalled()
  })
})
