// @vitest-environment happy-dom

import { act, type ReactNode } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { GitHistoryItem } from '../../../../shared/git-history'
import type { GitBranchChangeEntry } from '../../../../shared/types'
import {
  GitHistoryCommitFileContextMenu,
  type GitHistoryCommitFileAction
} from './GitHistoryCommitFileContextMenu'

vi.mock('@/components/ui/context-menu', () => ({
  ContextMenu: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-menu">{children}</div>
  ),
  ContextMenuTrigger: ({ children }: { children: ReactNode }) => (
    <div data-testid="context-trigger">{children}</div>
  ),
  ContextMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  ContextMenuItem: ({
    children,
    disabled,
    onSelect
  }: {
    children: ReactNode
    disabled?: boolean
    onSelect?: () => void
  }) => (
    <button type="button" disabled={disabled} onClick={onSelect}>
      {children}
    </button>
  ),
  ContextMenuSeparator: () => <hr />
}))

vi.mock('@/components/ui/tooltip', () => ({
  TooltipTrigger: ({ children }: { children: ReactNode }) => (
    <div data-testid="tooltip-trigger">{children}</div>
  )
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string) => fallback
}))

const item: GitHistoryItem = {
  id: '0123456789abcdef0123456789abcdef01234567',
  parentIds: ['fedcba9876543210fedcba9876543210fedcba98'],
  subject: 'Update source',
  message: 'Update source'
}
const entry: GitBranchChangeEntry = { path: 'src/a.ts', status: 'modified' }

let root: Root | null = null

function renderMenu(
  onAction: (
    action: GitHistoryCommitFileAction,
    item: GitHistoryItem,
    entry: GitBranchChangeEntry
  ) => void,
  overrides: { item?: GitHistoryItem; entry?: GitBranchChangeEntry } = {}
): HTMLDivElement {
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  act(() => {
    root?.render(
      <GitHistoryCommitFileContextMenu
        item={overrides.item ?? item}
        entry={overrides.entry ?? entry}
        onAction={onAction}
      >
        <button type="button" data-testid="file-row">
          a.ts
        </button>
      </GitHistoryCommitFileContextMenu>
    )
  })
  return container
}

describe('GitHistoryCommitFileContextMenu', () => {
  afterEach(() => {
    act(() => root?.unmount())
    root = null
    document.body.replaceChildren()
  })

  it('keeps the tooltip and context triggers on the file button and exposes snapshot-only actions', () => {
    const onAction = vi.fn()
    const container = renderMenu(onAction)
    const fileRow = container.querySelector<HTMLElement>('[data-testid="file-row"]')

    expect(fileRow?.parentElement?.dataset.testid).toBe('context-trigger')
    expect(fileRow?.parentElement?.parentElement?.dataset.testid).toBe('tooltip-trigger')
    expect(fileRow?.parentElement?.parentElement?.parentElement?.dataset.testid).toBe(
      'context-menu'
    )

    const buttons = Array.from(container.querySelectorAll<HTMLButtonElement>('button'))
    expect(buttons.map((button) => button.textContent?.trim())).toEqual([
      'a.ts',
      'Open Diff',
      'Open in Browser',
      'Copy Relative Path',
      'Copy Commit Hash'
    ])

    for (const button of buttons.slice(1)) {
      act(() => button.click())
    }
    expect(onAction.mock.calls.map(([action]) => action)).toEqual([
      'open-diff',
      'open-browser',
      'copy-relative-path',
      'copy-commit-hash'
    ])
  })

  it('disables the browser action for a deleted root-commit entry', () => {
    const container = renderMenu(vi.fn(), {
      item: { ...item, parentIds: [] },
      entry: { path: 'src/deleted.ts', oldPath: 'src/old.ts', status: 'deleted' }
    })
    const browserAction = Array.from(container.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Open in Browser')
    )

    expect(browserAction?.disabled).toBe(true)
  })
})
