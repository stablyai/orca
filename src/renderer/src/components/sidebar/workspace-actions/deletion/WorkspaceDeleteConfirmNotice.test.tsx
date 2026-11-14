import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/hooks/useShortcutLabel', () => ({
  useShortcutKeyDetails: () => ({ keys: ['⌘', '⇧', '⌫'], doubleTap: false })
}))

import { WorkspaceDeleteConfirmNotice } from './WorkspaceDeleteConfirmNotice'

describe('WorkspaceDeleteConfirmNotice', () => {
  it('asks for the bound chord again to delete a worktree', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDeleteConfirmNotice identity="local|repo::/a" isFolder={false} />
    )
    expect(html).toContain('role="status"')
    expect(html).toContain('data-workspace-delete-confirm="local|repo::/a"')
    expect(html).toContain('again to delete')
    expect(html).toContain('⌫')
  })

  it('says a folder workspace is only removed from Orca', () => {
    const html = renderToStaticMarkup(
      <WorkspaceDeleteConfirmNotice identity="local|folder:f" isFolder />
    )
    expect(html).toContain('again to remove from Orca')
  })
})
