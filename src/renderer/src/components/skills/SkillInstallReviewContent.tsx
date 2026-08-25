import type { ReactNode } from 'react'
import { AlertTriangle, Check } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import type {
  SkillInstallPreview,
  SkillInstallResult
} from '../../../../shared/skill-install-contract'
import { SkillPackageChecklist } from './SkillPackageChecklist'
import { checklistItemsFromVersion } from './skill-package-checklist-items'
import { SkillInstallRiskNotice } from './SkillInstallRiskNotice'
import type { SkillInstallRiskSummary } from './skill-package-install-risk'
import { skillInstallResultLabel } from './skill-install-result-label'
import type { ResolvedSkillShare } from './skill-share-version-summary'
import { translate } from '@/i18n/i18n'

/** Why: the submit lives in the dialog footer beside Close, so this is only the
 *  field; Enter still submits through the form. */
export function SkillShareLinkInputForm({
  link,
  onLinkChange,
  onSubmit
}: {
  link: string
  onLinkChange: (link: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <form
      className="space-y-2"
      onSubmit={(event) => {
        event.preventDefault()
        onSubmit()
      }}
    >
      <Label htmlFor="skill-share-link">
        {translate(
          'auto.components.skills.SkillInstallReviewContent.93eb0fe8c7',
          'Orca skill link'
        )}
      </Label>
      <Input
        id="skill-share-link"
        value={link}
        onChange={(event) => onLinkChange(event.target.value)}
        placeholder={translate(
          'auto.components.skills.SkillInstallReviewContent.66cff7a804',
          'https://app.orca.dev/skills/share/…'
        )}
        className="font-mono text-xs"
        autoFocus
      />
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.skills.install.linkHint',
          'Opening a link never installs anything — you review it first.'
        )}
      </p>
    </form>
  )
}

export function SkillInstallOutcome({ result }: { result: SkillInstallResult }): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div
        className="flex items-center gap-3 rounded-md border border-border p-3"
        role="status"
        aria-live="polite"
      >
        <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          {result.status === 'failed' || result.status === 'cancelled' ? (
            <AlertTriangle className="size-4" />
          ) : (
            <Check className="size-4" />
          )}
        </div>
        <div>
          <p className="text-sm font-medium">{skillInstallResultLabel(result)}</p>
          <p className="text-xs text-muted-foreground">
            {result.placements.length}{' '}
            {translate('auto.components.skills.SkillInstallReviewContent.3fc62a61eb', 'placement')}
            {result.placements.length === 1 ? '' : 's'}{' '}
            {translate('auto.components.skills.SkillInstallReviewContent.1b6ad2ca5c', 'checked.')}
          </p>
        </div>
      </div>
      {result.status === 'partial' ? (
        <div className="space-y-1 text-xs text-muted-foreground">
          {result.placements
            .filter((item) => item.status === 'failed' || item.status === 'skipped')
            .map((item) => (
              <p key={`${item.provider}:${item.path}`}>
                {item.provider}: {item.errorCategory || item.status}
              </p>
            ))}
        </div>
      ) : null}
      {result.failure ? (
        <p className="text-xs text-muted-foreground">
          {result.failure.code}
          {result.failure.retryable
            ? translate(
                'auto.components.skills.SkillInstallReviewContent.66270286ac',
                '· You can retry safely.'
              )
            : ''}
        </p>
      ) : null}
    </div>
  )
}

export function SkillInstallReview({
  preview,
  destinationPreview,
  result,
  busy,
  riskSummary,
  onDiscard,
  children
}: {
  preview: ResolvedSkillShare
  destinationPreview: SkillInstallPreview | null
  result: SkillInstallResult | null
  busy: boolean
  riskSummary: SkillInstallRiskSummary
  onDiscard: () => void
  children: ReactNode
}): React.JSX.Element {
  const version = preview.version
  const hasConflict =
    result?.status === 'conflict' ||
    (destinationPreview &&
      ['modified', 'unowned', 'external-link', 'name-collision'].includes(
        destinationPreview.currentState
      ))
  return (
    <div className="space-y-4">
      <div className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-3.5">
        <SkillPackageChecklist
          items={checklistItemsFromVersion(version)}
          selectedIds={null}
          busy={busy}
        />
        {version.releaseNotes.trim() ? (
          <p className="break-words whitespace-pre-wrap rounded-lg border border-border/40 bg-muted/40 p-3 text-xs leading-5 text-muted-foreground">
            <span className="font-semibold text-foreground">
              {translate(
                'auto.components.skills.SkillInstallReviewContent.releaseNotes',
                'Release notes:'
              )}
            </span>{' '}
            {version.releaseNotes}
          </p>
        ) : null}
        <SkillInstallRiskNotice summary={riskSummary} />
      </div>

      <div className="space-y-3 rounded-xl border border-border/70 bg-card/40 p-3.5">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {translate(
            'auto.components.skills.SkillInstallReviewContent.targetHeader',
            'Installation Target'
          )}
        </div>
        {children}
      </div>

      {hasConflict ? (
        <section
          className="space-y-2 rounded-xl border border-destructive/30 bg-destructive/5 p-3.5"
          role="alert"
        >
          <div className="flex items-center gap-2 text-sm font-medium text-destructive">
            <AlertTriangle className="size-4 shrink-0" />{' '}
            {translate(
              'auto.components.skills.SkillInstallReviewContent.651b7d8a57',
              'Local copy needs a decision'
            )}
          </div>
          <p className="text-xs leading-5 text-muted-foreground">
            {translate('auto.components.skills.SkillInstallReviewContent.2a31912f14', 'Orca found')}{' '}
            {result?.conflict?.kind ||
              destinationPreview?.currentState ||
              translate(
                'auto.components.skills.SkillInstallReviewContent.37d990b94c',
                'changed'
              )}{' '}
            {translate(
              'auto.components.skills.SkillInstallReviewContent.a5675fb371',
              'content and left it untouched. Keep it, or explicitly discard and replace it with this version.'
            )}
          </p>
          <Button type="button" variant="destructive" size="sm" disabled={busy} onClick={onDiscard}>
            {translate(
              'auto.components.skills.SkillInstallReviewContent.89e2601162',
              'Discard and replace'
            )}
          </Button>
        </section>
      ) : null}
    </div>
  )
}
