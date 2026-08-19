import { Check, Clipboard } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Progress } from '@/components/ui/progress'
import { translate } from '@/i18n/i18n'
import type {
  SkillSharePreview,
  SkillShareProgress
} from '../../../../shared/skill-sharing-contract'
import { SkillSharePackageSummary } from './SkillSharePackageSummary'
import { SkillShareReleaseNotesField } from './SkillShareReleaseNotesField'
import { shortDigest } from './skill-package-digest'

/** Radix warns about a missing description unless the caller opts out, so the
 *  dialog and its header have to agree on when one exists. */
export function skillShareDialogHasDescription(
  published: boolean,
  publishingNewVersion: boolean
): boolean {
  return !published && publishingNewVersion
}

export function SkillShareDialogHeader({
  published,
  publishingNewVersion,
  skillCount
}: {
  published: boolean
  publishingNewVersion: boolean
  skillCount: number
}): React.JSX.Element {
  const bundle = skillCount > 1
  return (
    <DialogHeader>
      <DialogTitle>
        {published
          ? bundle
            ? translate(
                'auto.components.skills.SkillShareReviewContent.bundleReady',
                'Skill bundle link ready'
              )
            : translate('auto.components.skills.SkillShareDialog.ready', 'Skill link ready')
          : publishingNewVersion
            ? bundle
              ? translate(
                  'auto.components.skills.SkillShareReviewContent.publishBundleVersion',
                  'Publish new skill bundle version'
                )
              : translate(
                  'auto.components.skills.SkillShareReviewContent.2dca0b720b',
                  'Publish new skill version'
                )
            : bundle
              ? translate(
                  'auto.components.skills.SkillShareReviewContent.shareBundle',
                  'Share skill bundle'
                )
              : translate('auto.components.skills.SkillShareDialog.title', 'Share skill')}
      </DialogTitle>
      {/* Why: the title and the access line already say what this does, so the
          only description left is the one case with a non-obvious outcome —
          publishing again adds a version instead of replacing the old one. */}
      {skillShareDialogHasDescription(published, publishingNewVersion) ? (
        <DialogDescription>
          {translate(
            'auto.components.skills.share.newVersionDescriptionPlain',
            'Adds a new version to the existing link.'
          )}
        </DialogDescription>
      ) : null}
    </DialogHeader>
  )
}

function SkillShareAccessSummary({
  hasCloudAccount
}: {
  hasCloudAccount: boolean
}): React.JSX.Element {
  return (
    <p className="text-xs leading-5 text-muted-foreground">
      {hasCloudAccount
        ? translate(
            'auto.components.skills.share.accessSummaryPlain',
            'Unlisted link — anyone with it can install this.'
          )
        : translate(
            'auto.components.skills.SkillShareReviewContent.c15d90c10b',
            'A connected Orca Cloud account is required.'
          )}
    </p>
  )
}

export function SkillSharePreparationReview({
  preview,
  hasCloudAccount,
  releaseNotes,
  publishingNewVersion,
  onReleaseNotesChange,
  onSubmit
}: {
  preview: SkillSharePreview
  hasCloudAccount: boolean
  releaseNotes: string
  publishingNewVersion: boolean
  onReleaseNotesChange: (notes: string) => void
  onSubmit: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-4">
      <SkillSharePackageSummary preview={preview} />
      <SkillShareAccessSummary hasCloudAccount={hasCloudAccount} />
      <SkillShareReleaseNotesField
        value={releaseNotes}
        newVersion={publishingNewVersion}
        onChange={onReleaseNotesChange}
        onSubmit={onSubmit}
      />
    </div>
  )
}

function publishingPhaseLabel(progress: SkillShareProgress | null): string {
  if (progress?.phase === 'publishing') {
    return translate(
      'auto.components.skills.SkillShareReviewContent.publishingLink',
      'Publishing link…'
    )
  }
  if (progress?.phase === 'finalizing') {
    return translate(
      'auto.components.skills.SkillShareReviewContent.verifyingPackage',
      'Verifying package…'
    )
  }
  return translate('auto.components.skills.SkillShareReviewContent.0142581727', 'Uploading…')
}

/** Rendered outside the scrolling review so upload feedback stays on screen next
 *  to the button that started it. */
export function SkillSharePublishProgress({
  progress,
  progressPercent
}: {
  progress: SkillShareProgress | null
  progressPercent: number
}): React.JSX.Element {
  const settled = progress?.phase === 'finalizing' || progress?.phase === 'publishing'
  const value = settled ? 100 : progressPercent
  return (
    <section className="space-y-2" aria-live="polite">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span id="skill-share-progress-label">{publishingPhaseLabel(progress)}</span>
        <span>{`${value}%`}</span>
      </div>
      <Progress aria-labelledby="skill-share-progress-label" value={value} />
    </section>
  )
}

export function SkillSharePublishedLink({
  shareUrl,
  packageDigest,
  onCopy,
  onManageLinks
}: {
  shareUrl: string
  packageDigest: string
  onCopy: () => void
  onManageLinks: () => void
}): React.JSX.Element {
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3 rounded-md border border-border p-3">
        <div className="flex size-8 items-center justify-center rounded-full bg-secondary text-secondary-foreground">
          <Check className="size-4" />
        </div>
        <p className="min-w-0 flex-1 truncate font-mono text-xs">{shareUrl}</p>
        <Button type="button" variant="outline" size="sm" onClick={onCopy}>
          <Clipboard className="size-4" />
          {translate('auto.components.skills.SkillShareReviewContent.6d6233a3a4', 'Copy link')}
        </Button>
      </div>
      <p className="font-mono text-[11px] text-muted-foreground" title={packageDigest}>
        {translate('auto.components.skills.SkillShareReviewContent.b3b1d4b911', 'SHA-256')}{' '}
        {shortDigest(packageDigest)}
      </p>
      <Button
        type="button"
        variant="link"
        className="h-auto p-0 text-xs font-normal text-muted-foreground"
        onClick={onManageLinks}
      >
        {translate(
          'auto.components.skills.share.manageLinks',
          'Manage or revoke this link in Settings'
        )}
      </Button>
    </div>
  )
}
