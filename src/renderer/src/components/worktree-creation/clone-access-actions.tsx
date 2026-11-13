// CLONE-ACCESS-ERROR: the card's copy and actions for a clone GitHub refused, by what GitHub says
// about Orca's access now (use-clone-access-handoff).
import { Copy, FolderSearch, Github, Loader2 } from 'lucide-react'
import type { Translate } from '@/i18n/use-translate'
import type { CloneAccessPhase } from './use-clone-access-handoff'
import { repoOwner } from './vm-build-clone-failure-copy'

export type CloneAccessHandlers = {
  phase: CloneAccessPhase
  giveAccess: () => void
  copyRequest: () => void
}

export type CloneAccessAction = {
  key: string
  label: string
  icon?: React.ReactNode
  onClick: () => void
  pending?: boolean
  secondary?: boolean
}

export function cloneAccessCopy(
  phase: CloneAccessPhase,
  repoName: string,
  t: Translate
): { title: string; body: string } {
  const repo = repoName
  const owner = repoOwner(repoName)
  if (phase === 'reachable') {
    return {
      title: t('worktreeCreation.cloneAccess.reachableTitle', 'Couldn’t clone {{repo}}', { repo }),
      body: t(
        'worktreeCreation.cloneAccess.reachableBody',
        'GitHub refused the clone, but Orca can reach this repository now. Try again. The sandbox was deleted.'
      )
    }
  }
  const title = t('worktreeCreation.cloneAccess.title', 'Orca can’t access {{repo}}', { repo })
  if (phase === 'requested') {
    return {
      title,
      body: t(
        'worktreeCreation.cloneAccess.askOwnerBody',
        'Ask an owner of {{owner}} to give Orca access. Orca tries again once they do. The sandbox was deleted.',
        { owner }
      )
    }
  }
  return {
    title,
    body: t(
      'worktreeCreation.cloneAccess.body',
      'The Orca GitHub App on {{owner}} doesn’t include this repository. Give Orca access, and Orca tries again. The sandbox was deleted.',
      { owner }
    )
  }
}

export function cloneAccessActions(
  access: CloneAccessHandlers,
  handlers: { onRetry: () => void; onChooseAnotherRepo: () => void },
  t: Translate
): CloneAccessAction[] {
  const chooseAnother: CloneAccessAction = {
    key: 'chooseAnotherRepo',
    label: t('worktreeCreation.cloneAccess.chooseAnother', 'Choose another repository'),
    icon: <FolderSearch />,
    onClick: handlers.onChooseAnotherRepo,
    secondary: true
  }
  switch (access.phase) {
    case 'reachable':
      return [
        {
          key: 'retry',
          label: t('auto.components.worktree.creation.VmBuildFailureCard.tryAgain', 'Try again'),
          onClick: handlers.onRetry
        },
        chooseAnother
      ]
    case 'requested':
      return [
        {
          key: 'copyRequest',
          label: t('worktreeCreation.cloneAccess.copyRequest', 'Copy request for an owner'),
          icon: <Copy />,
          onClick: access.copyRequest
        },
        chooseAnother
      ]
    case 'waiting':
      return [
        {
          key: 'giveAccess',
          label: t('worktreeCreation.cloneAccess.waiting', 'Waiting for GitHub…'),
          icon: <Loader2 className="animate-spin" />,
          onClick: access.giveAccess,
          pending: true
        },
        chooseAnother
      ]
    case 'checking':
    case 'missing':
      return [
        {
          // The App's install page, not a sign-in: no Copy link (AUTH-ONLY-COPY-LINK).
          key: 'giveAccess',
          label: t('worktreeCreation.cloneAccess.giveAccess', 'Give Orca access'),
          icon: <Github />,
          onClick: access.giveAccess
        },
        chooseAnother
      ]
  }
}

/** A failed clone's actions: access fixes when the clone was refused, else Try again. */
export function cloneFailedActions<A extends CloneAccessAction>(
  reason: string,
  actions: {
    onRetry: () => void
    onChooseAnotherRepo?: () => void
    cloneAccess?: CloneAccessHandlers
  },
  tryAgain: A,
  t: Translate
): (A | CloneAccessAction)[] {
  const { cloneAccess, onChooseAnotherRepo } = actions
  return reason === 'repo_unreachable' && cloneAccess && onChooseAnotherRepo
    ? cloneAccessActions(cloneAccess, { onRetry: actions.onRetry, onChooseAnotherRepo }, t)
    : [tryAgain]
}
