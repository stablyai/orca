import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorerRowContextMenu } from './file-explorer-row-context-menu'
import type { TreeNode } from './file-explorer-types'

type ItemProps = { onSelect?: () => void; disabled?: boolean; children?: React.ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const storeState = vi.hoisted(
  (): {
    activeWorktreeId: string
    activeWorkspaceExecutionHostId: 'local' | `runtime:${string}` | null
    openMarkdownPreview: () => void
    settings: { activeRuntimeEnvironmentId: string | null }
  } => ({
    activeWorktreeId: 'wt-1',
    activeWorkspaceExecutionHostId: null,
    openMarkdownPreview: () => {},
    settings: { activeRuntimeEnvironmentId: null }
  })
)
const revealInFileManager = vi.hoisted(() => vi.fn())

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
    ContextMenuShortcut: () => null
  }
})

vi.mock('@/store', () => ({
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
  revealInFileManager
}))

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

function renderRevealItem(
  owner: Partial<
    Pick<React.ComponentProps<typeof FileExplorerRowContextMenu>, 'connectionId' | 'node'>
  > = {}
): ItemProps | undefined {
  renderToStaticMarkup(
    <FileExplorerRowContextMenu
      node={fileNode}
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
      {...owner}
    />
  )
  return items.list.find((item) =>
    React.Children.toArray(item.children).includes('Reveal in Finder')
  )
}

function showsLocalOnlyHint(item: ItemProps | undefined): boolean {
  return renderToStaticMarkup(<>{item?.children}</>).includes('Local only')
}

describe('FileExplorerRowContextMenu host capabilities', () => {
  beforeEach(() => {
    items.list = []
    storeState.activeWorktreeId = 'wt-1'
    storeState.activeWorkspaceExecutionHostId = null
    storeState.settings.activeRuntimeEnvironmentId = null
    revealInFileManager.mockReset()
  })

  it.each(['runtime:remote', 'ssh:nested'] as const)(
    'keeps runtime-owned file Copy out of a %s row while retaining path copy',
    (executionHostId) => {
      renderRevealItem({
        node: {
          ...fileNode,
          operationOwner: { kind: 'runtime', environmentId: 'remote', executionHostId }
        }
      })
      const labels = items.list.flatMap((item) => React.Children.toArray(item.children))
      expect(labels).not.toContain('Copy')
      expect(labels).toContain('Copy Path')
      expect(labels).toContain('Copy Relative Path')
    }
  )

  it('reveals a local row through the shared reveal action', () => {
    const reveal = renderRevealItem()

    expect(reveal?.disabled).toBe(false)
    expect(showsLocalOnlyHint(reveal)).toBe(false)
    reveal?.onSelect?.()
    expect(revealInFileManager).toHaveBeenCalledWith('/repo/src/index.ts')
  })

  it('disables reveal as local-only for a row on an SSH host', () => {
    const reveal = renderRevealItem({ connectionId: 'ssh-1' })

    expect(reveal?.disabled).toBe(true)
    expect(showsLocalOnlyHint(reveal)).toBe(true)
  })

  it.each([
    ['worktree', 'wt-1'],
    ['folder workspace', 'folder:fw-1']
  ])('disables reveal as local-only for a row in a %s a remote runtime owns', (_kind, id) => {
    storeState.activeWorktreeId = id
    storeState.activeWorkspaceExecutionHostId = 'runtime:env-1'

    const reveal = renderRevealItem()

    expect(reveal?.disabled).toBe(true)
    expect(showsLocalOnlyHint(reveal)).toBe(true)
  })

  it('reveals a row in a local folder workspace', () => {
    storeState.activeWorktreeId = 'folder:fw-1'

    expect(renderRevealItem()?.disabled).toBe(false)
  })
})
