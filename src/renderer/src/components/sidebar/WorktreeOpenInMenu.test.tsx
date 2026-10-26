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
    },
    routeState: {}
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
    (selector: (state: typeof mockState) => unknown) => selector(mockState),
    {
      getState: () => ({
        ...mockState.routeState,
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
    mockState.routeState = {}
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

  it('enables only launchers that open SSH hosts themselves for SSH paths', () => {
    const entries = getWorktreeOpenInEntries(
      [
        { id: 'renamed', label: 'My Remote Editor', command: 'code-insiders' },
        { id: 'cursor', label: 'Cursor', command: 'cursor' },
        { id: 'zed', label: 'Zed', command: 'zed' },
        { id: 'fake', label: 'VS Code', command: 'subl' },
        { id: 'compound', label: 'VS Code Reuse', command: 'code --reuse-window' }
      ],
      'Finder'
    )

    for (const entry of entries.slice(0, 3)) {
      expect(getOpenInEntryAvailability(entry, 'ssh-1')).toEqual({
        disabled: false,
        metadata: 'Remote SSH'
      })
    }
    for (const entry of entries.slice(3, 5)) {
      expect(getOpenInEntryAvailability(entry, 'ssh-1')).toEqual({
        disabled: true,
        metadata: 'Local only',
        disabledReason: 'Only VS Code, Cursor, and Zed can open folders on an SSH host.'
      })
    }
    expect(getOpenInEntryAvailability(entries[5], 'ssh-1')).toEqual({
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
      command: 'subl'
    })

    expect(openInExternalEditorMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledWith('This app cannot open SSH workspaces.', {
      description: 'Choose VS Code, Cursor, or Zed, or use the app locally.'
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
      'This editor needs an SSH config alias for this host.',
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
      metadata: 'Local only',
      disabledReason:
        'Apps on this computer can open this server’s files only when Orca reaches it over SSH.'
    })
  })

  it('marks an unresolved owner local-only and never launches the desktop copy', async () => {
    const editor = { id: 'zed', label: 'Zed', target: 'external-editor', command: 'zed' } as const
    const fileManager = { id: 'file-manager', label: 'Finder', target: 'file-manager' } as const
    expect(getOpenInEntryAvailability(editor, null, null, true)).toEqual({
      disabled: true,
      metadata: 'Local only',
      disabledReason:
        'Apps on this computer can open this server’s files only when Orca reaches it over SSH.'
    })
    expect(getOpenInEntryAvailability(fileManager, null, null, true)).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
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

  describe('a workspace on a server Orca reaches through an SSH host', () => {
    const runtimeSshHost = { environmentId: 'managed-owner', sshTargetId: 'ssh-1' }
    const code = {
      id: 'code',
      label: 'VS Code',
      target: 'external-editor',
      command: 'code'
    } as const
    const subl = {
      id: 'subl',
      label: 'Sublime',
      target: 'external-editor',
      command: 'subl'
    } as const

    it('enables VS Code over Remote SSH and explains why other apps stay off', () => {
      expect(
        getOpenInEntryAvailability(code, null, 'managed-owner', false, runtimeSshHost)
      ).toEqual({ disabled: false, metadata: 'Remote SSH' })
      expect(
        getOpenInEntryAvailability(subl, null, 'managed-owner', false, runtimeSshHost)
      ).toEqual({
        disabled: true,
        metadata: 'Local only',
        disabledReason: 'Only VS Code, Cursor, and Zed can open folders on an SSH host.'
      })
    })

    it('sends the SSH host with the server as the owner', async () => {
      const worktreeId = 'repo-1::/home/ada/project'
      mockState.routeState = {
        runtimeEnvironments: [
          {
            id: 'managed-owner',
            orcadDeployment: {
              sshTargetId: 'ssh-1',
              sshTargetGeneration: 1,
              localPort: 41000,
              remotePort: 6768
            }
          }
        ],
        repos: [{ id: 'repo-1', connectionId: null, executionHostId: 'runtime:managed-owner' }],
        worktreesByRepo: {
          'repo-1': [
            {
              id: worktreeId,
              repoId: 'repo-1',
              hostId: 'runtime:managed-owner',
              runtimeOwnerEnvironmentId: 'managed-owner'
            }
          ]
        }
      }
      await openWorktreePath({
        target: 'external-editor',
        worktreePath: '/home/ada/project',
        connectionId: null,
        runtimeEnvironmentId: 'managed-owner',
        workspace: { workspaceId: worktreeId, hostId: 'runtime:managed-owner' },
        command: 'code'
      })

      expect(openInExternalEditorMock).toHaveBeenCalledWith({
        path: '/home/ada/project',
        command: 'code',
        connectionId: 'ssh-1',
        ownerHostId: 'runtime:managed-owner'
      })
    })

    it('keeps a server workspace with no SSH host local-only, saying why', () => {
      expect(getOpenInEntryAvailability(code, null, 'managed-owner', false, null)).toEqual({
        disabled: true,
        metadata: 'Local only',
        disabledReason:
          'Apps on this computer can open this server’s files only when Orca reaches it over SSH.'
      })
    })
  })
})
