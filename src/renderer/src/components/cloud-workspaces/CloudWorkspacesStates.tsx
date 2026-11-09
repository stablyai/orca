// Loading, empty and error states for the cloud workspaces list, and the new-section dialog.
import React, { useState } from 'react'
import { Button } from '@/components/ui/button'
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

export function ErrorState({
  message,
  retrying,
  onRetry
}: {
  message: string
  retrying: boolean
  onRetry: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <InlineError
      className="m-1"
      title={message}
      retryLabel={t('auto.components.cloudWorkspaces.retry', 'Retry')}
      retrying={retrying}
      onRetry={onRetry}
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
    <div
      aria-busy="true"
      aria-label={t('auto.components.cloudWorkspaces.loading', 'Loading cloud workspaces')}
    >
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
  filtered
}: {
  scope: 'team' | 'mine'
  archived: boolean
  filtered: boolean
}): React.JSX.Element {
  const t = useTranslate()
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
      : scope === 'team'
        ? [
            t('auto.components.cloudWorkspaces.emptyTeamTitle', 'No team workspaces yet'),
            t(
              'auto.components.cloudWorkspaces.emptyTeamBody',
              'Share a cloud workspace from its menu and everyone in your org can open it here.'
            )
          ]
        : [
            t('auto.components.cloudWorkspaces.emptyMineTitle', 'No cloud workspaces yet'),
            t(
              'auto.components.cloudWorkspaces.emptyMineBody',
              'Create one with Orca Cloud from New workspace. It keeps running while your laptop sleeps.'
            )
          ]
  return (
    <div className="flex flex-col items-center gap-1 px-6 py-8 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      <p className="max-w-sm text-xs text-muted-foreground">{body}</p>
    </div>
  )
}
