import { BookOpen, Download, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { SKILLS_PAGE_COLUMN } from './skills-page-column'

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7]

export function SkillsListSkeleton(): React.JSX.Element {
  return (
    <div>
      <p className="px-2 py-2 text-xs text-muted-foreground" role="status" aria-live="polite">
        {translate('auto.components.skills.SkillsPage.cd7893fbc1', 'Scanning skills')}
      </p>
      {SKELETON_ROWS.map((row) => (
        <div key={row} className="flex items-start gap-3 border-b border-border/50 px-2 py-2.5">
          <div className="mt-0.5 size-4 shrink-0 animate-pulse rounded bg-muted/70" />
          <div className="min-w-0 flex-1 space-y-2">
            <div className="h-3.5 w-48 animate-pulse rounded bg-muted/70" />
            <div className="h-3 w-full max-w-lg animate-pulse rounded bg-muted/50" />
          </div>
        </div>
      ))}
    </div>
  )
}

export function SkillsNoMatchesState({
  onClearFilters
}: {
  onClearFilters: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-2 px-2 py-12 text-center">
      <p className="text-sm font-semibold">
        {translate('auto.components.skills.SkillsPage.6a62a0168c', 'No matches')}
      </p>
      <p className="max-w-sm text-xs leading-5 text-muted-foreground">
        {translate(
          'auto.components.skills.SkillsPage.08a321a984',
          'No skill matches the current search and filters.'
        )}
      </p>
      <Button variant="outline" size="sm" className="mt-1" onClick={onClearFilters}>
        {translate('auto.components.skills.SkillsPage.clearFilters', 'Clear filters')}
      </Button>
    </div>
  )
}

export function SkillsEmptyState({
  onRefresh,
  onInstallFromLink
}: {
  onRefresh: () => void
  onInstallFromLink: () => void
}): React.JSX.Element {
  return (
    <div className="flex flex-col items-center gap-3 px-2 py-12 text-center">
      <BookOpen className="size-7 text-muted-foreground" />
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">
          {translate('auto.components.skills.SkillsPage.4acd6d68ec', 'No skills found')}
        </h2>
        <p className="max-w-sm text-xs leading-5 text-muted-foreground">
          {translate(
            'auto.components.skills.SkillsPage.emptyCopy',
            'The scanned skill folders are empty. Install a shared bundle, or refresh after adding a skill.'
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button variant="outline" size="sm" onClick={onInstallFromLink}>
          <Download className="size-4" />
          {translate('auto.components.skills.SkillsPage.aee7b99cc6', 'Install from link')}
        </Button>
        <Button variant="ghost" size="sm" onClick={onRefresh}>
          <RefreshCw className="size-4" />
          {translate('auto.components.skills.SkillsPage.cb142070b4', 'Refresh')}
        </Button>
      </div>
    </div>
  )
}

export function SkillsScanErrorBand({
  message,
  disabled,
  onRetry
}: {
  message: string
  disabled: boolean
  onRetry: () => void
}): React.JSX.Element {
  return (
    <div className="border-b border-destructive/30 bg-destructive/10">
      <div
        className={cn(SKILLS_PAGE_COLUMN, 'flex flex-wrap items-center justify-between gap-3 py-2')}
      >
        <p className="min-w-0 flex-1 text-xs text-destructive" role="alert">
          {message}
        </p>
        <Button type="button" variant="outline" size="xs" disabled={disabled} onClick={onRetry}>
          {translate('auto.components.skills.SkillsPage.retry', 'Retry')}
        </Button>
      </div>
    </div>
  )
}

/** One page-level sentence instead of the same reason repeated on every row. */
export function SkillsRemoteShareNotice({ hostLabel }: { hostLabel: string }): React.JSX.Element {
  return (
    <p className="border-b border-border/50 px-2 py-2 text-xs text-muted-foreground">
      {translate(
        'auto.components.skills.SkillsPage.remoteShareNotice',
        'These skills live on {{host}}. Open Skills on that machine to share them.',
        { host: hostLabel }
      )}
    </p>
  )
}
