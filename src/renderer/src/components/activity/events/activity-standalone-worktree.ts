import { i18n, translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { getTranslationResourceVersion } from '@/i18n/translation-resource-version'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../../shared/workspace/identity/floating-workspace-id'
import type { Worktree } from '../../../../../shared/worktree/types'
import type { ExecutionHostId } from '../../../../../shared/execution-host/execution-host'

const STANDALONE_ACTIVITY_WORKTREE_REPO_ID = '__activity_standalone__'
const STANDALONE_ACTIVITY_WORKTREES_CAP = 200
const standaloneActivityWorktrees = new Map<string, Worktree>()
// The cached rows carry a localized displayName, so they cannot outlive a language switch.
let cachedDisplayNameScope: string | undefined

function buildStandaloneActivityWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId,
  t: Translate = translate
): Worktree {
  const displayName =
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID
      ? t('auto.components.activity.standaloneWorktree.floatingTerminal', 'Floating terminal')
      : t('auto.components.activity.standaloneWorktree.standaloneTerminal', 'Standalone terminal')
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

/** Synthetic rows change with this scope, so cached Activity owners must too. */
export function standaloneActivityWorktreeScope(): string {
  return `${i18n.language}\0${getTranslationResourceVersion()}`
}

/** Return a stable synthetic worktree for terminal-only activity. */
export function standaloneActivityWorktree(
  worktreeId: string,
  executionHostId?: ExecutionHostId,
  t?: Translate
): Worktree {
  const displayNameScope = standaloneActivityWorktreeScope()
  if (cachedDisplayNameScope !== displayNameScope) {
    cachedDisplayNameScope = displayNameScope
    standaloneActivityWorktrees.clear()
  }
  const cacheKey = `${worktreeId}\0${executionHostId ?? ''}`
  let worktree = standaloneActivityWorktrees.get(cacheKey)
  if (!worktree) {
    if (standaloneActivityWorktrees.size >= STANDALONE_ACTIVITY_WORKTREES_CAP) {
      standaloneActivityWorktrees.clear()
    }
    worktree = buildStandaloneActivityWorktree(worktreeId, executionHostId, t)
    standaloneActivityWorktrees.set(cacheKey, worktree)
  }
  return worktree
}
