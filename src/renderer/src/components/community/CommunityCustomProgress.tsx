import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import type { CommunityFeature } from '../../../../shared/community-features'
export function CommunityCustomProgress({
  features,
  onOpen,
  onVerify,
  verifying,
  proofs
}: {
  features: CommunityFeature[]
  onOpen: (number: number) => void
  onVerify: (number: number) => Promise<void>
  verifying: number | null
  proofs: Record<number, string>
}): React.JSX.Element {
  const t = useTranslate()
  const currentSignals = (feature: CommunityFeature) =>
    feature.signals?.headSha === feature.source?.headSha ? feature.signals : null
  const counts = [
    {
      name: t('community.passingChecks', 'Passing checks'),
      count: features.filter((row) => currentSignals(row)?.checks === 'passed').length
    },
    {
      name: t('community.reviewApproval', 'Reviewer approval'),
      count: features.filter((row) => currentSignals(row)?.review === 'approved').length
    },
    {
      name: t('community.sourceMerge', 'Merged into source'),
      count: features.filter((row) => row.source?.state === 'merged').length
    },
    {
      name: t('community.inOfficialRelease', 'Source in an official release'),
      count: features.filter(
        (row) => proofs[row.number] || (row.release && row.release.headSha === row.source?.headSha)
      ).length
    }
  ]
  return (
    <div className="space-y-5">
      <div className="grid gap-4 md:grid-cols-2">
        {counts.map((item) => (
          <div key={item.name} className="space-y-3 rounded-xl border border-border p-5">
            <div className="flex justify-between gap-3 text-sm">
              <span>{item.name}</span>
              <strong>
                {item.count}/{features.length}
              </strong>
            </div>
            <div className="h-2 rounded-full bg-muted">
              <div
                className="h-full rounded-full bg-foreground/70"
                style={{ width: `${features.length ? (item.count / features.length) * 100 : 0}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        {t(
          'community.progressRules',
          'These are separate observed signals. They do not predict a merge date. Old-head checks and reviews are excluded. Release containment still needs behavior checks before retiring a Custom patch.'
        )}
      </p>
      {features.map((feature) => {
        const signals = currentSignals(feature)
        return (
          <article className="space-y-4 rounded-xl border border-border p-5" key={feature.number}>
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h3 className="text-sm font-semibold">
                  #{feature.number} · {feature.source?.title ?? feature.installed?.title}
                </h3>
                <p className="mt-2 font-mono text-2xs text-muted-foreground">
                  {feature.source?.headSha.slice(0, 12) ?? feature.installed?.headSha.slice(0, 12)}
                </p>
              </div>
              <Button variant="outline" size="sm" onClick={() => onOpen(feature.number)}>
                {t('community.openEvidence', 'Checks, reviews, and AI chat')}
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              <Badge variant="outline">
                {t('community.checksSignal', 'Checks')} ·{' '}
                {signals?.checks ?? t('community.noCurrentEvidence', 'No current evidence')}
              </Badge>
              <Badge variant="outline">
                {t('community.reviewSignal', 'Review')} ·{' '}
                {signals?.review ?? t('community.noCurrentEvidence', 'No current evidence')}
              </Badge>
              <Badge variant="outline">
                {t('community.mergeSignal', 'Merge')} ·{' '}
                {feature.source?.state ?? t('community.unobserved', 'Not observed')}
              </Badge>
              <Badge variant="outline">
                {t('community.releaseSignal', 'Release')} ·{' '}
                {proofs[feature.number] ??
                  (feature.release?.headSha === feature.source?.headSha
                    ? feature.release?.tag
                    : null) ??
                  t('community.unverified', 'Not verified')}
              </Badge>
            </div>
            {feature.source?.state === 'merged' && (
              <Button
                variant="outline"
                size="sm"
                disabled={verifying !== null}
                onClick={() => void onVerify(feature.number)}
              >
                {verifying === feature.number
                  ? t('community.verifyingRelease', 'Checking release…')
                  : t('community.verifyRelease', 'Verify official release')}
              </Button>
            )}
            {feature.release && (
              <a
                className="text-xs underline"
                href={feature.release.comparisonUrl}
                target="_blank"
                rel="noopener noreferrer"
              >
                {t('community.openReleaseProof', 'Open release containment proof')} ·{' '}
                {feature.release.tag}
              </a>
            )}
          </article>
        )
      })}
      {!features.length && (
        <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          {t(
            'community.noTrackedFeatures',
            'Select an addition or use a recorded Custom build to start tracking official progress.'
          )}
        </p>
      )}
    </div>
  )
}
