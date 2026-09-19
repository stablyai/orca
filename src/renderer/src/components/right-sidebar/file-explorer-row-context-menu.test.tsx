/**
 * @vitest-environment happy-dom
 */
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FileExplorerRowContextMenu } from './file-explorer-row-context-menu'
import { directoryNode, fileNode } from './file-explorer-tree-node-test-fixtures'

type ItemProps = { onSelect?: () => void; children?: React.ReactNode }

const items = vi.hoisted((): { list: ItemProps[] } => ({ list: [] }))
const attachExplorerFileAsContext = vi.hoisted(() => vi.fn())

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
    ContextMenuShortcut: passthrough
  }
})

vi.mock('@/store', () => {
  const state = {
    openMarkdownPreview: vi.fn(),
    activeWorktreeId: 'wt-1',
    worktreesByRepo: {},
    repos: [],
    settings: {}
  }
  const useAppStore = (selector: (value: typeof state) => unknown) => selector(state)
  useAppStore.getState = () => state
  return { useAppStore }
})

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutLabel: () => 'Unassigned'
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('./file-explorer-attach-as-context', () => ({
  attachExplorerFileAsContext
}))

function childrenText(children: React.ReactNode): string {
  return React.Children.toArray(children)
    .filter((child): child is string => typeof child === 'string')
    .join('')
}

function renderMenu(node: typeof fileNode, extras: { connectionId?: string | null } = {}): void {
  items.list = []
  renderToStaticMarkup(
    <FileExplorerRowContextMenu
      node={node}
      isExpanded={false}
      deleteShortcutLabel="⌫"
      connectionId={extras.connectionId}
      canOpenInOrcaBrowser={false}
      canCollapseFolderSubtree={false}
      targetDir="/repo"
      targetDepth={0}
      selectionSize={1}
      onViewFile={vi.fn()}
      onCopyPaths={vi.fn()}
      onStartNew={vi.fn()}
      onStartRename={vi.fn()}
      onDuplicate={vi.fn()}
      onAddFolderAsProject={vi.fn()}
      canAddAsProject={false}
      onOpenInTerminal={vi.fn()}
      onRequestDelete={vi.fn()}
      onCollapseFolderSubtree={vi.fn()}
      onFindInFolder={vi.fn()}
    />
  )
}

describe('FileExplorerRowContextMenu attach as context', () => {
  beforeEach(() => {
    attachExplorerFileAsContext.mockReset()
  })

  afterEach(() => {
    items.list = []
  })

  it('offers Attach as context for a file and attaches the resolved path', () => {
    renderMenu(fileNode, { connectionId: 'ssh-1' })

    const attachItem = items.list.find(
      (item) => childrenText(item.children) === 'Attach as context'
    )

    expect(attachItem).toBeDefined()
    attachItem?.onSelect?.()
    expect(attachExplorerFileAsContext).toHaveBeenCalledExactlyOnceWith(
      '/repo/src/index.ts',
      'ssh-1'
    )
  })

  it('does not offer Attach as context for a directory', () => {
    renderMenu(directoryNode)

    expect(items.list.some((item) => childrenText(item.children) === 'Attach as context')).toBe(
      false
    )
    expect(attachExplorerFileAsContext).not.toHaveBeenCalled()
  })
})
