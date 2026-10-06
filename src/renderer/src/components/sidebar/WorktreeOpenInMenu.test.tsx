import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import {
  getWorktreeOpenInEntries,
  getOpenInEntryAvailability,
  getLocalFileManagerLabel,
  openOpenInAppsSettings,
  openWorktreePath,
  WorktreeOpenInMenuItems,
  WorktreeOpenInSubMenu
} from './WorktreeOpenInMenu'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const owner = vi.hoisted(
  (): { runtimeEnvironmentId: string | null; connectionId: string | null } => ({
    runtimeEnvironmentId: null,
    connectionId: null
  })
)

vi.mock(import('@/lib/worktree-runtime-owner'), async (importOriginal) => ({
  ...(await importOriginal()),
  getLocalOpenRuntimeOwnerForWorktree: () => owner.runtimeEnvironmentId,
  getLocalOpenSshOwnerForWorktree: () => owner.connectionId
}))

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
    owner.runtimeEnvironmentId = null
    owner.connectionId = null
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
      worktreeId: 'worktree-1',
      worktreePath: '/tmp/workspace',
      connectionId: null,
      disabled: true
    })

    expect(findByType(tree, DropdownMenuSubTrigger).props.disabled).toBe(true)
  })

  it('stops menu item click propagation', () => {
    const tree = WorktreeOpenInSubMenu({
      worktreeId: 'worktree-1',
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
    mockState.settings = { activeRuntimeEnvironmentId: 'runtime-1', openInApplications: [] }

    await openWorktreePath({
      target: 'file-manager',
      worktreePath: '/tmp/workspace',
      connectionId: null
    })

    expect(toastErrorMock).toHaveBeenCalledWith(
      'Opening remote paths in the local OS is not available.'
    )
    expect(openInFileManagerMock).not.toHaveBeenCalled()
    expect(openInExternalEditorMock).not.toHaveBeenCalled()
  })

  it('opens a local workspace while a remote runtime is focused', async () => {
    // Why: global runtime focus is not ownership; the workspace's own owner decides.
    mockState.settings = { activeRuntimeEnvironmentId: 'runtime-1', openInApplications: [] }
    const [vsCode, fileManager] = getWorktreeOpenInEntries(
      [{ id: 'vscode', label: 'VS Code', command: 'code' }],
      'Finder'
    )

    expect(getOpenInEntryAvailability(vsCode, mockState.settings, null, null)).toEqual({
      disabled: false
    })
    expect(getOpenInEntryAvailability(fileManager, mockState.settings, null, null)).toEqual({
      disabled: false
    })
    await openWorktreePath({
      target: 'file-manager',
      worktreePath: '/tmp/workspace',
      connectionId: null,
      runtimeEnvironmentId: null
    })

    expect(openInFileManagerMock).toHaveBeenCalledWith('/tmp/workspace', null)
    expect(toastErrorMock).not.toHaveBeenCalled()
  })

  it('keeps a runtime-owned workspace local-only when no runtime is focused', async () => {
    const [entry] = getWorktreeOpenInEntries([], 'Finder')

    expect(getOpenInEntryAvailability(entry, mockState.settings, null, 'runtime-1')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
    await openWorktreePath({
      target: 'file-manager',
      worktreePath: '/tmp/workspace',
      connectionId: null,
      runtimeEnvironmentId: 'runtime-1'
    })

    expect(openInFileManagerMock).not.toHaveBeenCalled()
    expect(toastErrorMock).toHaveBeenCalledTimes(1)
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
      connectionId: null
    })
    expect(toastErrorMock).toHaveBeenCalledWith('Could not open workspace folder.', {
      description: 'Check the editor command or file manager configuration on this machine.'
    })
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
      connectionId: null
    })
  })

  it('blocks configured launchers in remote context before calling main IPC', async () => {
    mockState.settings = { activeRuntimeEnvironmentId: 'runtime-1', openInApplications: [] }

    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/tmp/workspace',
      connectionId: null,
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

    expect(getOpenInEntryAvailability(entries[0], mockState.settings, 'ssh-1')).toEqual({
      disabled: false,
      metadata: 'Remote SSH'
    })
    expect(getOpenInEntryAvailability(entries[1], mockState.settings, 'ssh-1')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
    expect(getOpenInEntryAvailability(entries[2], mockState.settings, 'ssh-1')).toEqual({
      disabled: true,
      metadata: 'Local only'
    })
    expect(getOpenInEntryAvailability(entries[3], mockState.settings, 'ssh-1')).toEqual({
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
      connectionId: 'ssh-1'
    })
  })

  it('treats an SSH folder workspace as SSH even though its repo prop has no connection', () => {
    // Why: a folder workspace's synthetic repo has no connectionId; an SSH route has no runtime.
    mockState.settings = {
      activeRuntimeEnvironmentId: 'runtime-1',
      openInApplications: [{ id: 'vscode', label: 'VS Code', command: 'code' }]
    }
    owner.connectionId = 'ssh-1'

    const [vsCode, fileManager] = WorktreeOpenInMenuItems({
      worktreeId: 'folder:fw-1',
      worktreePath: '/home/ada/project',
      connectionId: null
    }).props.children

    expect(fileManager.props.disabled).toBe(true)
    expect(vsCode.props.disabled).toBe(false)
    vsCode.props.onSelect()
    expect(openInExternalEditorMock).toHaveBeenCalledWith({
      path: '/home/ada/project',
      command: 'code',
      connectionId: 'ssh-1',
      runtimeEnvironmentId: null
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
})
