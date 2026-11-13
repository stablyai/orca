// Loading, empty and error states for the cloud workspaces list, and the new-section dialog.
import React, { useState } from 'react'
import { Cloud, List } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useAppStore } from '@/store'
import { openNewCloudWorkspace } from '@/hooks/ipc-events/new-workspace-command'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { InlineError } from '@/components/ui/inline-error'
import { Input } from '@/components/ui/input'
import { Skeleton } from '@/components/ui/skeleton'
import { useTranslate } from '@/i18n/use-translate'
import { SignInAgainNotice } from '@/components/orca-cloud/SignInAgainButton'
import { describeInlineError } from './cloud-workspace-errors'
import { openCloudWorkspacesHome } from './cloud-workspaces-home-nav'

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
  if (error === 'unauthorized' && reason !== 'mfa_required') {
    return <SignInAgainNotice className="m-1" onSignIn={onSignIn} />
  }
  // At the running-sandbox limit a retry can't help: show your workspaces so one can go to sleep.
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
            onClick={() => openCloudWorkspacesHome({ running: true })}
          >
            <List aria-hidden />
            {t('auto.components.cloudWorkspaces.showCloudWorkspaces', 'Show cloud workspaces')}
          </Button>
        ) : undefined
      }
    />
  )
}

/** Names a new section; mounted only while open so each opening starts empty. */
export function NewSectionDialog({
  onCancel,
  onSubmit
}: {
  onCancel: () => void
  onSubmit: (name: string) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [sectionName, setSectionName] = useState('')
  return (
    <Dialog open onOpenChange={(next) => !next && onCancel()}>
      <DialogContent className="sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>
            {t('auto.components.cloudWorkspaces.newSection', 'New section')}
          </DialogTitle>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault()
            const name = sectionName.trim()
            if (name) {
              onSubmit(name.slice(0, 64))
            }
          }}
        >
          <Input
            autoFocus
            value={sectionName}
            maxLength={64}
            placeholder={t(
              'auto.components.cloudWorkspaces.sectionNamePlaceholder',
              'e.g. Payments'
            )}
            aria-label={t('auto.components.cloudWorkspaces.sectionName', 'Section name')}
            onChange={(e) => setSectionName(e.target.value)}
          />
          <DialogFooter className="mt-4">
            <Button type="button" variant="ghost" onClick={onCancel}>
              {t('auto.components.cloudWorkspaces.cancel', 'Cancel')}
            </Button>
            <Button type="submit" disabled={!sectionName.trim()}>
              {t('auto.components.cloudWorkspaces.move', 'Move')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
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

export function EmptyState({
  scope,
  archived,
  filtered,
  hasOrg = true,
  archivedCount = 0,
  onShowArchived
}: {
  scope: 'team' | 'mine'
  archived: boolean
  filtered: boolean
  /** On a team: an empty Mine list says it's yours that's empty, not that nobody has started one. */
  hasOrg?: boolean
  /** Archived workspaces in this scope: an empty list then says so and offers them (ARCHIVE-REACH). */
  archivedCount?: number
  onShowArchived?: () => void
}): React.JSX.Element {
  const t = useTranslate()
  // Nothing to filter or share yet: say how to start one (JA-30), in the glossary's own words.
  const startBody = t(
    'components.cloudWorkspaces.emptyStartBody',
    'It runs in a sandbox, so your agents keep working even when this computer is off.'
  )
  const [title, body] = filtered
    ? [
        t('auto.components.cloudWorkspaces.emptyFilteredTitle', 'Nothing matches these filters'),
        t('auto.components.cloudWorkspaces.emptyFilteredBody', 'Try another owner or repository.')
      ]
    : archived
      ? [
          t('auto.components.cloudWorkspaces.emptyArchivedTitle', 'No archived workspaces'),
          t(
            'auto.components.cloudWorkspaces.emptyArchivedBody',
            'Archived cloud workspaces show up here.'
          )
        ]
      : archivedCount > 0
        ? [
            t(
              'components.cloudWorkspaces.emptyAllArchivedTitle',
              'All your cloud workspaces are archived'
            ),
            t(
              'components.cloudWorkspaces.emptyAllArchivedBody',
              'Unarchive one to keep working, or start a new one.'
            )
          ]
        : scope === 'mine' && hasOrg
          ? [
              t(
                'components.cloudWorkspaces.emptyMineYoursTitle',
                'You don’t have any cloud workspaces yet.'
              ),
              startBody
            ]
          : [
              t('components.cloudWorkspaces.emptyFirstTitle', 'Start your first cloud workspace'),
              startBody
            ]
  // Spec E3: an empty Mine or Team list offers a real button, not just copy.
  const offerCreate = !filtered && !archived
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
      {offerCreate ? (
        <Button
          type="button"
          size="sm"
          className="mt-3"
          onClick={() => openNewCloudWorkspace(useAppStore.getState(), 'unknown')}
        >
          <Cloud className="size-3.5" />
          {t('components.cloudWorkspaces.newCloudWorkspace', 'New cloud workspace')}
        </Button>
      ) : null}
      {offerCreate && archivedCount > 0 && onShowArchived ? (
        <Button type="button" size="sm" variant="quiet" className="mt-1" onClick={onShowArchived}>
          {t('components.cloudWorkspaces.showArchivedCount', 'Show archived ({{count}})', {
            count: archivedCount
          })}
        </Button>
      ) : null}
    </div>
  )
}
