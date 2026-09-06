import { i18n, translate } from '@/i18n/i18n'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { Worktree } from '../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../shared/execution-host'

const STANDALONE_ACTIVITY_WORKTREE_REPO_ID = '__activity_standalone__'
const STANDALONE_ACTIVITY_WORKTREES_CAP = 200
const standaloneActivityWorktrees = new Map<string, Worktree>()
// The cached rows carry a localized displayName, so they cannot outlive a language switch.
let cachedDisplayNameLocale: string | undefined

function buildStandaloneActivityWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Worktree {
  const displayName =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? translate(
          'auto.components.activity.standaloneWorktree.floatingTerminal',
          'Floating terminal'
        )
      : translate(
          'auto.components.activity.standaloneWorktree.standaloneTerminal',
          'Standalone terminal'
        )
  return {
    id: worktreeId,
    ...(executionHostId ? { hostId: executionHostId } : {}),
    repoId: STANDALONE_ACTIVITY_WORKTREE_REPO_ID,
    path: '',
    head: '',
    branch: displayName,
    isBare: false,
    isMainWorktree: false,
    displayName,
    comment: '',
    linkedIssue: null,
    linkedPR: null,
    linkedLinearIssue: null,
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 0,
    lastActivityAt: 0
  }
}

/** Return a stable synthetic worktree for terminal-only activity. */
export function standaloneActivityWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId
): Worktree {
  if (cachedDisplayNameLocale !== i18n.language) {
    cachedDisplayNameLocale = i18n.language
    standaloneActivityWorktrees.clear()
  }
  const cacheKey = `${worktreeId}\0${executionHostId ?? ''}`
  let worktree = standaloneActivityWorktrees.get(cacheKey)
  if (!worktree) {
    if (standaloneActivityWorktrees.size >= STANDALONE_ACTIVITY_WORKTREES_CAP) {
      standaloneActivityWorktrees.clear()
    }
    worktree = buildStandaloneActivityWorktree(worktreeId, executionHostId)
    standaloneActivityWorktrees.set(cacheKey, worktree)
  }
  return worktree
}
