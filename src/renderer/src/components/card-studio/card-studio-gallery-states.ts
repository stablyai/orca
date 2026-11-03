import type { AppState } from '@/store/types'
import { getWorkspaceAttachments } from '../../../../shared/workspace-attachments'
import { isFolderRepo } from '../../../../shared/repo-kind'
import type { Repo } from '../../../../shared/repo-types'
import type { Worktree } from '../../../../shared/worktree/types'
import { translate } from '@/i18n/i18n'

export type CardStudioGalleryEntry = { key: string; label: string; worktree: Worktree; repo?: Repo }

type StateRule = {
  key: string
  label: () => string
  matches: (worktree: Worktree, repo: Repo | undefined, agentStates: ReadonlySet<string>) => boolean
}

// The states people most want to check, each shown with a real workspace in that state.
const STATE_RULES: readonly StateRule[] = [
  {
    key: 'working',
    label: () => translate('auto.components.cardStudio.state.working', 'Agent working'),
    matches: (_w, _r, states) => states.has('working')
  },
  {
    key: 'blocked',
    label: () => translate('auto.components.cardStudio.state.blocked', 'Needs input'),
    matches: (_w, _r, states) => states.has('blocked')
  },
  {
    key: 'review',
    label: () => translate('auto.components.cardStudio.state.review', 'Pull request'),
    matches: (worktree) =>
      worktree.linkedPR != null ||
      getWorkspaceAttachments(worktree).some((item) => item.type !== 'issue')
  },
  {
    key: 'unread',
    label: () => translate('auto.components.cardStudio.state.unread', 'Unread'),
    matches: (worktree) => worktree.isUnread
  },
  {
    key: 'ssh',
    label: () => translate('auto.components.cardStudio.state.ssh', 'Remote (SSH)'),
    matches: (_w, repo) => Boolean(repo?.connectionId)
  },
  {
    key: 'folder',
    label: () => translate('auto.components.cardStudio.state.folder', 'Folder'),
    matches: (_w, repo) => Boolean(repo && isFolderRepo(repo))
  },
  {
    key: 'main',
    label: () => translate('auto.components.cardStudio.state.main', 'Primary checkout'),
    matches: (worktree) => worktree.isMainWorktree
  },
  {
    key: 'comment',
    label: () => translate('auto.components.cardStudio.state.comment', 'With notes'),
    matches: (worktree) => worktree.comment.trim().length > 0
  }
]

/** One real workspace per state, starting with the one the Studio opened on; never repeats one. */
export function pickCardStudioGallery(
  state: Pick<AppState, 'worktreesByRepo' | 'repos' | 'agentStatusByPaneKey'>,
  focusedWorktreeId: string | null
): CardStudioGalleryEntry[] {
  const repos = new Map(state.repos.map((repo) => [repo.id, repo]))
  const worktrees = Object.values(state.worktreesByRepo)
    .flat()
    .filter((worktree) => !worktree.isArchived)
  const agentStates = new Map<string, Set<string>>()
  for (const entry of Object.values(state.agentStatusByPaneKey)) {
    if (entry.worktreeId) {
      const states = agentStates.get(entry.worktreeId) ?? new Set<string>()
      states.add(entry.state)
      agentStates.set(entry.worktreeId, states)
    }
  }
  const used = new Set<string>()
  const entries: CardStudioGalleryEntry[] = []
  const add = (key: string, label: string, worktree: Worktree): void => {
    used.add(worktree.id)
    entries.push({ key, label, worktree, repo: repos.get(worktree.repoId) })
  }
  const focused = worktrees.find((worktree) => worktree.id === focusedWorktreeId)
  if (focused) {
    add('focused', translate('auto.components.cardStudio.state.focused', 'This workspace'), focused)
  }
  const none = new Set<string>()
  for (const rule of STATE_RULES) {
    const match = worktrees.find(
      (worktree) =>
        !used.has(worktree.id) &&
        rule.matches(worktree, repos.get(worktree.repoId), agentStates.get(worktree.id) ?? none)
    )
    if (match) {
      add(rule.key, rule.label(), match)
    }
  }
  return entries
}
