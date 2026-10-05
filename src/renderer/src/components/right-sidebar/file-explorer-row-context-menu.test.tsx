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
    openMarkdownPreview: () => void
    settings: { activeRuntimeEnvironmentId: string | null }
  } => ({
    activeWorktreeId: 'wt-1',
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

function fileNode(operationOwner: TreeNode['operationOwner']): TreeNode {
  return {
    name: 'index.ts',
    path: '/repo/src/index.ts',
    relativePath: 'src/index.ts',
    isDirectory: false,
    depth: 1,
    operationOwner
  }
}

function renderRevealItem(operationOwner: TreeNode['operationOwner']): ItemProps | undefined {
  renderToStaticMarkup(
    <FileExplorerRowContextMenu
      node={fileNode(operationOwner)}
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
  return items.list.find((item) =>
    React.Children.toArray(item.children).includes('Reveal in Finder')
  )
}

function showsLocalOnlyHint(item: ItemProps | undefined): boolean {
  return renderToStaticMarkup(<>{item?.children}</>).includes('Local only')
}

describe('FileExplorerRowContextMenu reveal in file manager', () => {
  beforeEach(() => {
    items.list = []
    storeState.activeWorktreeId = 'wt-1'
    storeState.settings.activeRuntimeEnvironmentId = null
    revealInFileManager.mockReset()
  })

  it('reveals a locally listed row while a remote runtime is focused', () => {
    // Why: a globally focused remote runtime used to block reveal for local rows too.
    storeState.settings.activeRuntimeEnvironmentId = 'env-1'

    const reveal = renderRevealItem({ kind: 'local' })

    expect(reveal?.disabled).toBe(false)
    expect(showsLocalOnlyHint(reveal)).toBe(false)
    reveal?.onSelect?.()
    expect(revealInFileManager).toHaveBeenCalledWith('/repo/src/index.ts', null)
  })

  it('reveals a locally listed row in a folder workspace', () => {
    storeState.activeWorktreeId = 'folder:fw-1'

    expect(renderRevealItem({ kind: 'local' })?.disabled).toBe(false)
  })

  const nonLocalOwners: [string, TreeNode['operationOwner']][] = [
    ['runtime', { kind: 'runtime', environmentId: 'env-1', executionHostId: 'runtime:env-1' }],
    ['ssh', { kind: 'ssh', connectionId: 'ssh-1' }],
    ['unresolved', { kind: 'unresolved' }],
    ['unstamped', undefined]
  ]

  it.each(nonLocalOwners)('disables reveal as local-only for a %s row', (_label, owner) => {
    const reveal = renderRevealItem(owner)

    expect(reveal?.disabled).toBe(true)
    expect(showsLocalOnlyHint(reveal)).toBe(true)
  })
})
