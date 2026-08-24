import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SourceControlEntryContextMenu } from './source-control/listing/entry-context-menu'

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const openInMocks = vi.hoisted(() => ({
  executionHostId: 'local' as 'local' | `ssh:${string}` | `runtime:${string}`,
  getOpenInEntryAvailability: vi.fn(() => ({ disabled: false })),
  openWorktreePath: vi.fn()
}))

vi.mock('@/components/ui/context-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)

  return {
    ContextMenu: passthrough,
    ContextMenuContent: passthrough,
    ContextMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    },
    ContextMenuSeparator: () => null,
    ContextMenuSub: passthrough,
    ContextMenuSubContent: passthrough,
    ContextMenuSubTrigger: passthrough,
    ContextMenuTrigger: passthrough
  }
})

vi.mock('@/store', () => ({
  useAppStore: (selector: (state: { settings: { openInApplications: never[] } }) => unknown) =>
    selector({ settings: { openInApplications: [] } })
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/local-file-manager-label', () => ({
  getLocalFileManagerLabel: () => 'Finder'
}))

vi.mock('@/lib/open-in-app-catalog', () => ({
  OpenInApplicationIcon: () => null
}))

vi.mock('@/components/sidebar/WorktreeOpenInMenu', () => ({
  getOpenInEntryAvailability: openInMocks.getOpenInEntryAvailability,
  getWorktreeOpenInEntries: () => [
    { id: 'vscode', label: 'VS Code', target: 'external-editor', command: 'code' }
  ],
  openOpenInAppsSettings: vi.fn(),
  openWorktreePath: openInMocks.openWorktreePath
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getExecutionHostIdForWorktree: () => openInMocks.executionHostId
}))

function childrenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .map((child) => {
      if (typeof child === 'string') {
        return child
      }
      return React.isValidElement<{ children?: React.ReactNode }>(child)
        ? childrenText(child.props.children)
        : ''
    })
    .join('')
}

describe('SourceControlEntryContextMenu', () => {
  const writeClipboardText = vi.fn()

  beforeEach(() => {
    items.list = []
    openInMocks.executionHostId = 'local'
    openInMocks.getOpenInEntryAvailability.mockClear()
    openInMocks.openWorktreePath.mockReset()
    writeClipboardText.mockReset()
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies the supplied relative path', () => {
    renderToStaticMarkup(
      <SourceControlEntryContextMenu
        currentWorktreeId="worktree-1"
        absolutePath="/repo/src/example.ts"
        relativePath="src/example.ts"
        onRevealInExplorer={vi.fn()}
      >
        <div />
      </SourceControlEntryContextMenu>
    )

    const copyRelativePathItem = items.list.find(
      (item) => childrenText(item.children) === 'Copy Relative Path'
    )

    expect(copyRelativePathItem).toBeDefined()
    copyRelativePathItem?.onSelect?.()
    expect(writeClipboardText).toHaveBeenCalledWith('src/example.ts')
  })

  it('opens runtime-owned paths with the worktree execution host', () => {
    openInMocks.executionHostId = 'runtime:devbox'

    renderToStaticMarkup(
      <SourceControlEntryContextMenu
        currentWorktreeId="worktree-1"
        absolutePath="/workspaces/project/src/example.ts"
        relativePath="src/example.ts"
        onRevealInExplorer={vi.fn()}
      >
        <div />
      </SourceControlEntryContextMenu>
    )

    const vscodeItem = items.list.find((item) => childrenText(item.children) === 'VS Code')

    expect(vscodeItem).toBeDefined()
    expect(openInMocks.getOpenInEntryAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vscode' }),
      expect.anything(),
      null,
      'runtime:devbox'
    )
    vscodeItem?.onSelect?.()
    expect(openInMocks.openWorktreePath).toHaveBeenCalledWith({
      target: 'external-editor',
      worktreePath: '/workspaces/project/src/example.ts',
      connectionId: null,
      executionHostId: 'runtime:devbox',
      command: 'code'
    })
  })

  it('drops the repository SSH connection for an explicitly local worktree', () => {
    renderToStaticMarkup(
      <SourceControlEntryContextMenu
        currentWorktreeId="worktree-1"
        absolutePath="/repo/src/example.ts"
        relativePath="src/example.ts"
        connectionId="repo-ssh"
        onRevealInExplorer={vi.fn()}
      >
        <div />
      </SourceControlEntryContextMenu>
    )

    const vscodeItem = items.list.find((item) => childrenText(item.children) === 'VS Code')

    expect(openInMocks.getOpenInEntryAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vscode' }),
      expect.anything(),
      null,
      'local'
    )
    vscodeItem?.onSelect?.()
    expect(openInMocks.openWorktreePath).toHaveBeenCalledWith({
      target: 'external-editor',
      worktreePath: '/repo/src/example.ts',
      connectionId: null,
      executionHostId: 'local',
      command: 'code'
    })
  })

  it('uses the worktree SSH target instead of the repository connection', () => {
    openInMocks.executionHostId = 'ssh:worktree-ssh'

    renderToStaticMarkup(
      <SourceControlEntryContextMenu
        currentWorktreeId="worktree-1"
        absolutePath="/repo/src/example.ts"
        relativePath="src/example.ts"
        connectionId="repo-ssh"
        onRevealInExplorer={vi.fn()}
      >
        <div />
      </SourceControlEntryContextMenu>
    )

    const vscodeItem = items.list.find((item) => childrenText(item.children) === 'VS Code')

    expect(openInMocks.getOpenInEntryAvailability).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'vscode' }),
      expect.anything(),
      'worktree-ssh',
      'ssh:worktree-ssh'
    )
    vscodeItem?.onSelect?.()
    expect(openInMocks.openWorktreePath).toHaveBeenCalledWith({
      target: 'external-editor',
      worktreePath: '/repo/src/example.ts',
      connectionId: 'worktree-ssh',
      executionHostId: 'ssh:worktree-ssh',
      command: 'code'
    })
  })
})
