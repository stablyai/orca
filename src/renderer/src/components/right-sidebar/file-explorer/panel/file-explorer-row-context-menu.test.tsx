import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorerRowContextMenu } from './file-explorer-row-context-menu'
import type { TreeNode } from '../tree/file-explorer-types'

type ItemProps = { onSelect?: () => void; disabled?: boolean; children?: React.ReactNode }

const items = vi.hoisted((): { list: ItemProps[] } => ({ list: [] }))
const storeState = vi.hoisted(() => ({
  activeWorktreeId: 'wt-1',
  activeWorkspaceExecutionHostId: null,
  openMarkdownPreview: () => {},
  settings: { activeRuntimeEnvironmentId: null },
  worktreesByRepo: { 'repo-1': [{ id: 'wt-1', repoId: 'repo-1', hostId: 'local' }] },
  folderWorkspaces: [{ id: 'fw-1', projectGroupId: 'group-1' }],
  projectGroups: [{ id: 'group-1' }]
}))

vi.mock('@/components/ui/context-menu', async () => {
  const React_ = await import('react')
  const passthrough = ({ children }: { children?: React.ReactNode }) =>
    React_.createElement(React_.Fragment, null, children)
  return {
    ContextMenuContent: passthrough,
    ContextMenuItem: (props: ItemProps) => {
      items.list.push(props)
      return React_.createElement(React_.Fragment, null, props.children)
    },
    ContextMenuSeparator: () => null,
    ContextMenuShortcut: () => null,
    ContextMenuSub: passthrough,
    ContextMenuSubContent: passthrough,
    ContextMenuSubTrigger: passthrough
  }
})

vi.mock('@/store/index', () => ({
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/hooks/useShortcutLabel', () => ({ useShortcutLabel: () => 'Unassigned' }))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/file-preview', () => ({ openFileInBrowserTab: vi.fn() }))

vi.mock(import('@/lib/reveal-in-file-manager'), async (importOriginal) => ({
  ...(await importOriginal()),
  getRevealInFileManagerLabel: () => 'Reveal in Finder',
  revealInFileManager: vi.fn()
}))

vi.mock('../../../file-actions/OpenInContextSubmenu', () => ({ OpenInContextSubmenu: () => null }))

vi.mock('./file-explorer-row-file-transfer', () => ({
  copyFileToOsClipboard: vi.fn(),
  downloadRemoteFile: vi.fn()
}))

const fileNode: TreeNode = {
  name: 'index.ts',
  path: '/repo/src/index.ts',
  relativePath: 'src/index.ts',
  isDirectory: false,
  depth: 1
}

function renderMenuItemLabels(readOnly: boolean): React.ReactNode[] {
  renderToStaticMarkup(
    <FileExplorerRowContextMenu
      node={fileNode}
      readOnly={readOnly}
      isExpanded={false}
      deleteShortcutLabel=""
      targetDir="/repo/src"
      targetDepth={1}
      selectionSize={1}
      onViewFile={vi.fn()}
      onCopyPaths={vi.fn()}
      onStartNew={vi.fn()}
      onStartRename={vi.fn()}
      onDuplicate={vi.fn()}
      onRequestDelete={vi.fn()}
      canOpenInOrcaBrowser={false}
      canCollapseFolderSubtree={false}
      canAddAsProject={false}
      onAddFolderAsProject={vi.fn()}
      onOpenInTerminal={vi.fn()}
      onCollapseFolderSubtree={vi.fn()}
      onFindInFolder={vi.fn()}
    />
  )
  return items.list.flatMap((item) => React.Children.toArray(item.children))
}

describe('FileExplorerRowContextMenu outside the workspace', () => {
  beforeEach(() => {
    items.list = []
  })

  it('hides Copy Relative Path for outside-workspace rows while keeping Copy Path', () => {
    const labels = renderMenuItemLabels(true)
    expect(labels).toContain('Copy Path')
    expect(labels).not.toContain('Copy Relative Path')
  })
})
