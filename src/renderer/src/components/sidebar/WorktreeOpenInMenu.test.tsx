import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DropdownMenuSubContent, DropdownMenuSubTrigger } from '@/components/ui/dropdown-menu'
import {
  getLocalFileManagerLabel,
  openWorktreePath,
  WorktreeOpenInSubMenu
} from './WorktreeOpenInMenu'

type ReactElementLike = {
  type: unknown
  props: Record<string, unknown>
}

const { mockState, openInExternalEditorMock, openInFileManagerMock, toastErrorMock } = vi.hoisted(
  () => ({
    mockState: {
      settings: { activeRuntimeEnvironmentId: null as string | null }
    },
    openInExternalEditorMock: vi.fn(),
    openInFileManagerMock: vi.fn(),
    toastErrorMock: vi.fn()
  })
)

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
      getState: () => ({ settings: mockState.settings })
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
    mockState.settings = { activeRuntimeEnvironmentId: null }
    toastErrorMock.mockReset()
    openInFileManagerMock.mockReset()
    openInExternalEditorMock.mockReset()
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
    mockState.settings = { activeRuntimeEnvironmentId: 'runtime-1' }

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

  it('shows an actionable toast when the host launcher fails', async () => {
    openInExternalEditorMock.mockResolvedValueOnce({ ok: false, reason: 'launch-failed' })

    await openWorktreePath({
      target: 'external-editor',
      worktreePath: '/tmp/workspace',
      connectionId: null
    })

    expect(openInExternalEditorMock).toHaveBeenCalledWith('/tmp/workspace')
    expect(toastErrorMock).toHaveBeenCalledWith('Could not open workspace folder.', {
      description: 'Check the editor command or file manager configuration on this machine.'
    })
  })
})
