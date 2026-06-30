import type { TerminalTab, Worktree } from '../../../shared/types'

type UnreadBadgeArgs = {
  worktreesByRepo: Record<string, Worktree[]>
  tabsByWorktree: Record<string, TerminalTab[]>
  unreadTerminalTabs: Record<string, true>
}

export type UnreadBadgeContributor = {
  id: string
  repoLabel: string | null
  worktreeId: string | null
  worktreeLabel: string
  unreadWorktree: boolean
  unreadTabIds: string[]
  unreadTabTitles: string[]
}

export type UnreadBadgeModel = {
  count: number
  contributors: UnreadBadgeContributor[]
}

function getUnreadTabTitle(tab: TerminalTab): string {
  return tab.customTitle || tab.title || tab.generatedTitle || tab.defaultTitle || tab.id
}

export function getUnreadBadgeModel({
  worktreesByRepo,
  tabsByWorktree,
  unreadTerminalTabs
}: UnreadBadgeArgs): UnreadBadgeModel {
  const contributorsByWorktreeId = new Map<string, UnreadBadgeContributor>()
  const worktreesById = new Map<string, Worktree>()

  for (const worktrees of Object.values(worktreesByRepo)) {
    for (const worktree of worktrees) {
      worktreesById.set(worktree.id, worktree)
      if (worktree.isUnread) {
        contributorsByWorktreeId.set(worktree.id, {
          id: worktree.id,
          repoLabel: worktree.repoId ?? null,
          worktreeId: worktree.id,
          worktreeLabel: worktree.displayName,
          unreadWorktree: true,
          unreadTabIds: [],
          unreadTabTitles: []
        })
      }
    }
  }

  function ensureWorktreeContributor(worktreeId: string): UnreadBadgeContributor {
    const existing = contributorsByWorktreeId.get(worktreeId)
    if (existing) {
      return existing
    }

    const worktree = worktreesById.get(worktreeId)
    const contributor: UnreadBadgeContributor = {
      id: worktreeId,
      repoLabel: worktree?.repoId ?? null,
      worktreeId,
      worktreeLabel: worktree?.displayName ?? worktreeId,
      unreadWorktree: false,
      unreadTabIds: [],
      unreadTabTitles: []
    }
    contributorsByWorktreeId.set(worktreeId, contributor)
    return contributor
  }

  const unreadTabIds = new Set(Object.keys(unreadTerminalTabs))
  for (const [worktreeId, tabs] of Object.entries(tabsByWorktree)) {
    for (const tab of tabs) {
      if (!unreadTabIds.delete(tab.id)) {
        continue
      }
      const contributor = ensureWorktreeContributor(worktreeId)
      contributor.unreadTabIds.push(tab.id)
      contributor.unreadTabTitles.push(getUnreadTabTitle(tab))
    }
  }

  const contributors = Array.from(contributorsByWorktreeId.values())
  for (const tabId of unreadTabIds) {
    contributors.push({
      id: `detached:${tabId}`,
      repoLabel: null,
      worktreeId: null,
      worktreeLabel: '',
      unreadWorktree: false,
      unreadTabIds: [tabId],
      unreadTabTitles: [tabId]
    })
  }

  return {
    count: contributors.length,
    contributors
  }
}

export function getUnreadBadgeCount(args: UnreadBadgeArgs): number {
  return getUnreadBadgeModel(args).count
}
