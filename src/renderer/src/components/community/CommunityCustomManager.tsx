import { communityRequestResult } from './community-request-result'
import { CommunityCustomProgress } from './CommunityCustomProgress'
import { CommunityCandidateHistory } from './CommunityCandidateHistory'
import { communityClient } from './community-client'
import { useState } from 'react'
import { Check, ExternalLink, FlaskConical, Package } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { CommunityFeaturesSnapshot } from '../../../../shared/community-features'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import { getCustomBuildInfo } from '../../../../shared/custom-build'
import { CommunityCandidate } from './CommunityCandidate'
export function CommunityCustomManager({
  personal,
  target,
  onOpen,
  onBrowse
}: {
  personal: CommunityFeaturesSnapshot
  target: RuntimeClientTarget
  onOpen: (number: number) => void
  onBrowse: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [section, setSection] = useState('included')
  const [proofBusy, setProofBusy] = useState<number | null>(null)
  const [proofs, setProofs] = useState<Record<number, string>>({})
  const [error, setError] = useState<string | null>(null)
  const build = getCustomBuildInfo()
  const features = Object.values(personal.features)
  const selected = features.filter((row) => row.selectedAt)
  const tracked = features.filter(
    (row) => row.selectedAt || (build && row.installed?.buildId === build.id)
  )
  const merged = tracked.filter((row) => row.source?.state === 'merged')
  const history = features.filter(
    (row) =>
      row.release || (row.source && row.source.state !== 'open') || (!row.selectedAt && row.chat)
  )
  const verify = async (number: number): Promise<void> => {
    setProofBusy(number)
    setError(null)
    const result = await communityRequestResult(async () => {
      const proof = await communityClient(target).verifyRelease(number)
      setProofs((previous) => ({ ...previous, [number]: proof.tag }))
    })
    if (!result.ok) {
      setError(result.message)
    }
    setProofBusy(null)
  }
  return (
    <div className="space-y-6">
      <header className="flex flex-wrap justify-between gap-4">
        <div>
          <Badge variant="outline">
            <FlaskConical className="size-3" />
            {build
              ? t('community.customLabel', 'Custom')
              : t('community.customPlan', 'Custom plan')}
          </Badge>
          <h2 className="mt-3 text-2xl font-semibold">
            {t('community.myCustom', 'My Custom build')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            {build
              ? `${t('community.basedOn', 'Based on official Orca')} ${build.baseVersion} · ${build.changes.length} ${t('community.includedChanges', 'included changes')}`
              : t(
                  'community.planDescription',
                  'Choose additions, review evidence, and track what reaches official Orca.'
                )}
          </p>
        </div>
        <Button variant="outline" onClick={onBrowse}>
          {t('community.findChanges', 'Find more changes')}
        </Button>
      </header>
      <Tabs value={section} onValueChange={setSection}>
        <TabsList variant="line" className="w-full justify-start">
          <TabsTrigger className="flex-none" value="included">
            {t('community.included', 'Included changes')}
          </TabsTrigger>
          <TabsTrigger className="flex-none" value="progress">
            {t('community.officialProgress', 'Official progress')}
          </TabsTrigger>
          <TabsTrigger className="flex-none" value="history">
            {t('community.featureHistory', 'Feature history')}
          </TabsTrigger>
        </TabsList>
      </Tabs>
      {section === 'included' && (
        <>
          <div className="grid gap-4 md:grid-cols-3">
            {[
              {
                name: t('community.inThisBuild', 'In this build'),
                count: build?.changes.length ?? 0
              },
              {
                name: t('community.selectedAdditions', 'Selected additions'),
                count: selected.length
              },
              { name: t('community.mergedSelections', 'Selected PRs merged'), count: merged.length }
            ].map((item) => (
              <Card key={item.name} size="sm">
                <CardContent>
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">{item.name}</p>
                    <p className="text-3xl font-semibold">{item.count}</p>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
          {build && (
            <section className="rounded-xl border border-border p-5">
              <h3 className="mb-3 text-sm font-semibold">
                {t('community.runningChanges', 'Changes in the running build')}
              </h3>
              <ul className="divide-y divide-border">
                {build.changes.map((change) => (
                  <li className="flex items-start gap-3 py-3 text-sm" key={change.id}>
                    <Check className="mt-0.5 size-4 shrink-0" />
                    <div>
                      <p>{change.title}</p>
                      {change.pullRequest && (
                        <Button
                          variant="link"
                          size="inline"
                          onClick={() => onOpen(change.pullRequest!.number)}
                        >
                          #{change.pullRequest.number} ·{' '}
                          {t('community.openEvidenceShort', 'Open evidence')}
                        </Button>
                      )}
                      <p className="mt-1 font-mono text-2xs text-muted-foreground">{change.id}</p>
                    </div>
                  </li>
                ))}
              </ul>
              <p className="mt-3 break-all font-mono text-2xs text-muted-foreground">{build.id}</p>
            </section>
          )}
          <section>
            <h3 className="mb-3 text-base font-semibold">
              {t('community.nextAdditions', 'Selected for the next candidate')}
            </h3>
            <p className="mb-4 text-xs text-muted-foreground">
              {t(
                'community.selectionNote',
                'These selections are not installed until a compatible candidate is approved and applied.'
              )}
            </p>
            <div className="grid gap-3 md:grid-cols-2">
              {selected.map((feature) => (
                <Button
                  key={feature.number}
                  variant="outline"
                  className="h-auto justify-start text-left whitespace-normal"
                  onClick={() => onOpen(feature.number)}
                >
                  <span>
                    <span className="block text-sm font-medium">
                      #{feature.number} · {feature.source?.title ?? feature.installed?.title}
                    </span>
                    {feature.source?.imageUrls[0] && (
                      <img
                        src={feature.source.imageUrls[0]}
                        alt={feature.source.title}
                        loading="lazy"
                        referrerPolicy="no-referrer"
                        className="mt-3 h-32 w-full rounded-md bg-muted object-contain"
                      />
                    )}
                    <span className="mt-2 block text-xs font-normal text-muted-foreground">
                      {feature.source?.state} · {feature.source?.headSha.slice(0, 12)}
                    </span>
                  </span>
                </Button>
              ))}
            </div>
            {!selected.length && (
              <Button variant="outline" onClick={onBrowse}>
                {t('community.selectFirst', 'Choose your first addition')}
              </Button>
            )}
          </section>
          <CommunityCandidate target={target} />
          {target.kind === 'local' && (
            <section className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-5">
              <div>
                <h3 className="text-sm font-semibold">
                  {t('community.haveBuild', 'Have a trusted local build?')}
                </h3>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t(
                    'community.localBuildNote',
                    'Orca checks its signature, profile schema, and terminal compatibility before it offers installation.'
                  )}
                </p>
              </div>
              <Button
                variant="outline"
                onClick={() =>
                  void window.api.updater
                    .check({ localBuild: true })
                    .catch((cause) => setError(String(cause)))
                }
              >
                <Package className="size-4" />
                {t('community.chooseBuild', 'Choose compatible build')}
              </Button>
            </section>
          )}
        </>
      )}
      {section === 'progress' && (
        <CommunityCustomProgress
          features={tracked}
          onOpen={onOpen}
          onVerify={verify}
          verifying={proofBusy}
          proofs={proofs}
        />
      )}
      {section === 'history' && (
        <>
          <CommunityCandidateHistory target={target} />
          <p className="text-sm text-muted-foreground">
            {t(
              'community.historyNote',
              'Past selections and conversations remain here. A merged PR needs release evidence before its Custom patch can retire.'
            )}
          </p>
          {history.map((feature) => (
            <div
              className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border p-5"
              key={feature.number}
            >
              <div>
                <h3 className="text-sm font-semibold">
                  #{feature.number} · {feature.source?.title ?? feature.installed?.title}
                </h3>
                <p className="mt-2 text-xs text-muted-foreground">
                  {feature.source?.state} ·{' '}
                  {feature.source?.observedAt &&
                    new Date(feature.source.observedAt).toLocaleString(locale)}
                </p>
              </div>
              <Button variant="outline" onClick={() => onOpen(feature.number)}>
                {t('community.openHistory', 'Open history and conversation')}
              </Button>
            </div>
          ))}
          {!history.length && (
            <p className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">
              {t(
                'community.noFeatureHistory',
                'History will appear when a selected PR closes or merges. Your linked conversations stay available.'
              )}
            </p>
          )}
          <Button variant="link" asChild>
            <a
              href="https://github.com/stablyai/orca/releases"
              target="_blank"
              rel="noopener noreferrer"
            >
              <ExternalLink className="size-4" />
              {t('community.publishedVersions', 'Published official versions')}
            </a>
          </Button>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  )
}
