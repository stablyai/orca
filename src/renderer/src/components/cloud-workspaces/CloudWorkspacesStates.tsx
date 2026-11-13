// Loading, empty and error states for the "Open cloud workspace…" list.
import React from 'react'
import { Cloud, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { InlineError } from '@/components/ui/inline-error'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { SignInAgainNotice } from '@/components/orca-cloud/SignInAgainButton'
import { describeInlineError } from './cloud-workspace-errors'
import { openCloudWorkspacePicker } from './cloud-workspace-picker-store'

/** The list failed to load. An expired session offers Sign in; anything else offers Try again. */
export function ErrorState({
  error,
  reason,
  retrying,
  onRetry,
  onSignIn
}: {
  error: string
  reason?: string
  retrying: boolean
  onRetry: () => void
  onSignIn: () => void
}): React.JSX.Element {
  const t = useTranslate()
  if (error === 'unauthorized') {
    return <SignInAgainNotice className="m-1" onSignIn={onSignIn} />
  }
  // At the running-sandbox limit a retry can't help: list your running ones so one can go to sleep.
  const atLimit =
    error === 'entitlement_denied' &&
    (reason === 'concurrency_limit' || reason === 'member_concurrency_limit')
  return (
    <InlineError
      className="m-1"
      title={describeInlineError(error, reason, t)}
      retryLabel={atLimit ? undefined : t('orcaCloudWorkspace.tryAgain', 'Try again')}
      retrying={retrying}
      onRetry={atLimit ? undefined : onRetry}
      action={
        atLimit ? (
          <Button
            variant="outline"
            size="xs"
            onClick={() => openCloudWorkspacePicker({ kind: 'running' })}
          >
            <List aria-hidden />
            {t('auto.components.cloudWorkspaces.showCloudWorkspaces', 'Show cloud workspaces')}
          </Button>
        ) : undefined
      }
    />
  )
}

export function SkeletonRows(): React.JSX.Element {
  const t = useTranslate()
  return (
    <div role="status" aria-busy="true">
      <span className="sr-only">
        {t('auto.components.cloudWorkspaces.loading', 'Loading cloud workspaces')}
      </span>
      {[0, 1, 2].map((i) => (
        // Same height and columns as a real row (status, title + meta, cost, last active, ⋯).
        <div key={i} className="flex h-14 items-center gap-3 pl-3 pr-2">
          <Skeleton className="size-2" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3 w-2/5" />
            <Skeleton className="h-2.5 w-1/4" />
          </div>
          <Skeleton className="h-3 w-10" />
          <Skeleton className="h-3 w-12" />
          <span className="size-6" />
        </div>
      ))}
    </div>
  )
}

/** Why the list is empty, in the words of what the picker was opened for. */
export type PickerEmptyReason =
  | { kind: 'search' }
  | { kind: 'archived' }
  /** Everything you can open is in the sidebar already. */
  | { kind: 'all-in-sidebar' }
  | { kind: 'none-running' }
  | { kind: 'teammate'; name: string }
  | { kind: 'none' }

export function PickerEmptyState({
  reason,
  onCreate
}: {
  reason: PickerEmptyReason
  /** Offered only when there are none at all: start one. */
  onCreate?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [title, body] = ((): [string, string] => {
    switch (reason.kind) {
      case 'search':
        return [
          t('components.cloudWorkspaces.picker.emptySearchTitle', 'Nothing matches your search'),
          t(
            'components.cloudWorkspaces.picker.emptySearchBody',
            'Try a title, repository, branch, owner or W-number.'
          )
        ]
      case 'archived':
        return [
          t('auto.components.cloudWorkspaces.emptyArchivedTitle', 'No archived workspaces'),
          t(
            'auto.components.cloudWorkspaces.emptyArchivedBody',
            'Archived cloud workspaces show up here.'
          )
        ]
      case 'all-in-sidebar':
        return [
          t(
            'components.cloudWorkspaces.picker.emptyAllInSidebarTitle',
            'Your cloud workspaces are already in the sidebar'
          ),
          t(
            'components.cloudWorkspaces.picker.emptyAllInSidebarBody',
            'Workspaces teammates share, and ones you start on another computer, show up here.'
          )
        ]
      case 'none-running':
        return [
          t('components.cloudWorkspaces.picker.emptyRunningTitle', 'None of yours are running'),
          t(
            'components.cloudWorkspaces.picker.emptyRunningBody',
            'Teammates’ running workspaces can count toward the limit too. Try again in a moment.'
          )
        ]
      case 'teammate':
        return [
          t(
            'components.cloudWorkspaces.picker.emptyTeammateTitle',
            '{{name}} has no cloud workspaces you can see',
            { name: reason.name }
          ),
          t(
            'components.cloudWorkspaces.picker.emptyTeammateBody',
            'Private workspaces only show to their owner.'
          )
        ]
      case 'none':
        return [
          t('components.cloudWorkspaces.emptyFirstTitle', 'Start your first cloud workspace'),
          t(
            'components.cloudWorkspaces.emptyStartBody',
            'It runs in a sandbox, so your agents keep working even when this computer is off.'
          )
        ]
    }
  })()
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
      {reason.kind === 'none' && onCreate ? (
        <Button type="button" size="sm" className="mt-3" onClick={onCreate}>
          <Cloud className="size-3.5" />
          {t('components.cloudWorkspaces.newCloudWorkspace', 'New cloud workspace')}
        </Button>
      ) : null}
    </div>
  )
}
