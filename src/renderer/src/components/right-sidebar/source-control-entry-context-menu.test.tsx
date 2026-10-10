import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpenInApplication } from '../../../../shared/ui-chrome-types'
import { SourceControlEntryContextMenu } from './source-control/listing/entry-context-menu'

type ItemProps = { onSelect?: () => void; disabled?: boolean; children?: React.ReactNode }

const items = vi.hoisted(() => ({ list: [] as ItemProps[] }))
const storeState = vi.hoisted(
  (): {
    settings: {
      openInApplications: OpenInApplication[]
      activeRuntimeEnvironmentId: string | null
    }
  } => ({
    settings: { openInApplications: [], activeRuntimeEnvironmentId: null }
  })
)
const ownerRuntime = vi.hoisted((): { environmentId: string | null } => ({ environmentId: null }))
const revealInFileManager = vi.hoisted(() => vi.fn())
const openWorktreePath = vi.hoisted(() => vi.fn())

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
  useAppStore: (selector: (state: typeof storeState) => unknown) => selector(storeState)
}))

vi.mock('@/lib/worktree-runtime-owner', () => ({
  getRuntimeEnvironmentIdForWorktree: () => ownerRuntime.environmentId
}))

vi.mock(import('@/lib/reveal-in-file-manager'), async (importOriginal) => ({
  ...(await importOriginal()),
  getRevealInFileManagerLabel: () => 'Reveal in Finder',
  revealInFileManager
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

vi.mock('@/lib/open-in-app-catalog', () => ({
  OpenInApplicationIcon: () => null
}))

vi.mock('@/components/sidebar/WorktreeOpenInMenu', async () => {
  const { getExternalEditorOpenCapability } = await import('@/lib/external-editor-open-capability')
  return {
    getOpenInEntryAvailability: (
      entry: { command?: string },
      settings: typeof storeState.settings,
      connectionId?: string | null,
      runtimeEnvironmentId?: string | null
    ) => ({
      disabled: !getExternalEditorOpenCapability(settings, {
        command: entry.command,
        connectionId,
        runtimeEnvironmentId
      }).allowed
    }),
    openOpenInAppsSettings: vi.fn(),
    openWorktreePath
  }
})

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

function showsLocalOnlyHint(item: ItemProps | undefined): boolean {
  return renderToStaticMarkup(<>{item?.children}</>).includes('Local only')
}

function renderMenu(props: { connectionId?: string; hasWorkingTreeFile?: boolean } = {}): void {
  renderToStaticMarkup(
    <SourceControlEntryContextMenu
      currentWorktreeId="worktree-1"
      absolutePath="/repo/src/example.ts"
      relativePath="src/example.ts"
      hasWorkingTreeFile={props.hasWorkingTreeFile ?? true}
      connectionId={props.connectionId}
      onRevealInExplorer={vi.fn()}
    >
      <div />
    </SourceControlEntryContextMenu>
  )
}

function renderRevealItem(props?: Parameters<typeof renderMenu>[0]): ItemProps | undefined {
  renderMenu(props)
  return items.list.find((item) => childrenText(item.children) === 'Reveal in Finder')
}

describe('SourceControlEntryContextMenu', () => {
  const writeClipboardText = vi.fn()

  beforeEach(() => {
    items.list = []
    storeState.settings.activeRuntimeEnvironmentId = null
    storeState.settings.openInApplications = []
    ownerRuntime.environmentId = null
    revealInFileManager.mockReset()
    openWorktreePath.mockReset()
    writeClipboardText.mockReset()
    vi.stubGlobal('window', {
      api: { ui: { writeClipboardText } }
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('copies the supplied relative path', () => {
    renderMenu()

    const copyRelativePathItem = items.list.find(
      (item) => childrenText(item.children) === 'Copy Relative Path'
    )

    expect(copyRelativePathItem).toBeDefined()
    copyRelativePathItem?.onSelect?.()
    expect(writeClipboardText).toHaveBeenCalledWith('src/example.ts')
  })

  it('reveals the changed file in the OS file manager (issue #24003)', () => {
    const revealItem = renderRevealItem()

    expect(revealItem?.disabled).toBe(false)
    expect(showsLocalOnlyHint(revealItem)).toBe(false)
    revealItem?.onSelect?.()
    expect(revealInFileManager).toHaveBeenCalledWith('/repo/src/example.ts')
  })

  it('offers the file manager once, outside the "Open in" apps', () => {
    storeState.settings.openInApplications = [{ id: 'zed', label: 'Zed', command: 'zed' }]

    renderMenu()

    const labels = items.list.map((item) => childrenText(item.children))
    expect(labels).toContain('Zed')
    expect(labels).not.toContain('Finder')
    expect(labels.filter((label) => label === 'Reveal in Finder')).toHaveLength(1)
  })

  it('uses the target owner for editor availability and click dispatch while focus is local', () => {
    ownerRuntime.environmentId = 'env-2'
    storeState.settings.openInApplications = [{ id: 'zed', label: 'Zed', command: 'zed' }]
    renderMenu()

    const editorItem = items.list.find((item) => childrenText(item.children) === 'Zed')
    expect(editorItem?.disabled).toBe(true)
    editorItem?.onSelect?.()
    expect(openWorktreePath).toHaveBeenCalledWith({
      target: 'external-editor',
      worktreePath: '/repo/src/example.ts',
      connectionId: undefined,
      runtimeEnvironmentId: 'env-2',
      command: 'zed'
    })
  })

  it('disables reveal, with no reason, for a deleted file', () => {
    const revealItem = renderRevealItem({ hasWorkingTreeFile: false })

    expect(revealItem?.disabled).toBe(true)
    expect(showsLocalOnlyHint(revealItem)).toBe(false)
  })

  it('disables reveal as local-only for a repo on an SSH host', () => {
    const revealItem = renderRevealItem({ connectionId: 'ssh-1' })

    expect(revealItem?.disabled).toBe(true)
    expect(showsLocalOnlyHint(revealItem)).toBe(true)
  })

  it('disables reveal as local-only for a repo owned by a runtime that is not the focused one', () => {
    ownerRuntime.environmentId = 'env-2'

    const revealItem = renderRevealItem()

    expect(revealItem?.disabled).toBe(true)
    expect(showsLocalOnlyHint(revealItem)).toBe(true)
  })
})
