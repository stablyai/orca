import { buildPaletteTabDocument } from '@/lib/palette-match/tab-document'
import type { SearchableWorkspaceTab } from '@/lib/workspace-tab-palette-search'
import { makeUnifiedTab, makeWorktree } from '../worktree-jump-palette-test-fixtures'

export function transcriptTab(id: string, title = id, secondaryText = ''): SearchableWorkspaceTab {
  const worktree = makeWorktree('workspace', 'Example workspace')
  return {
    tab: { ...makeUnifiedTab(id, worktree.id, id, title), contentType: 'terminal' },
    worktree,
    repoName: 'Example',
    worktreeSortIndex: 0,
    groupSortIndex: 0,
    tabSortIndex: 0,
    title,
    secondaryText,
    titleSearchText: title,
    secondarySearchTexts: [secondaryText],
    agentMetadata: [],
    occupantAgent: 'claude',
    isCurrentTab: false,
    isCurrentWorktree: false,
    document: buildPaletteTabDocument({
      id,
      title,
      secondaryTexts: [secondaryText],
      worktreeName: 'Example workspace',
      branch: 'main',
      repoName: 'Example'
    })
  }
}
