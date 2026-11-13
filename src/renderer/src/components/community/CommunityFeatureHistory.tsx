import { communityRequestResult } from './community-request-result'
import { useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { useIntlLocale, useTranslate } from '@/i18n/use-translate'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { CommunityDetail } from '../../../../shared/community-operations'
import { communityClient } from './community-client'
export function CommunityFeatureHistory({
  detail,
  target
}: {
  detail: CommunityDetail
  target: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
  const locale = useIntlLocale()
  const [events, setEvents] = useState(detail.history.events)
  const [next, setNext] = useState(detail.history.nextBefore)
  const [evidence, setEvidence] = useState<unknown>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let current = true
    void communityClient(target)
      .history(detail.pr.number)
      .then((page) => {
        if (current) {
          setEvents(page.events)
          setNext(page.nextBefore)
        }
      })
      .catch((cause) => {
        if (current) {
          setError(String(cause))
        }
      })
    return () => {
      current = false
    }
  }, [target, detail.pr.number])
  const perform = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError(null)
    const result = await communityRequestResult(async () => {
      await operation()
    })
    if (!result.ok) {
      setError(result.message)
    }
    setBusy(false)
  }
  return (
    <section className="space-y-5">
      <h3 className="text-base font-semibold">
        {t('community.changeHistory', 'Changes and proof')}
      </h3>
      <ol className="space-y-4 border-l border-border pl-5">
        {events.map((event) => (
          <li key={event.id} className="space-y-1">
            <p className="text-sm font-medium">{event.summary}</p>
            <p className="text-xs text-muted-foreground">
              {event.actor} · {new Date(event.at).toLocaleString(locale)}
            </p>
            {event.headSha && (
              <code className="block break-all text-2xs text-muted-foreground">
                {event.headSha}
              </code>
            )}
            {event.evidence
              .filter((id) => /^[a-f0-9]{64}$/.test(id))
              .map((id) => (
                <Button
                  key={id}
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void perform(async () =>
                      setEvidence(await communityClient(target).evidence(id))
                    )
                  }
                >
                  {t('community.openCapture', 'Open captured evidence')} · {id.slice(0, 12)}
                </Button>
              ))}
          </li>
        ))}
      </ol>
      {next !== null && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const page = await communityClient(target).history(detail.pr.number, next)
              setEvents((old) => [...old, ...page.events])
              setNext(page.nextBefore)
            })
          }
        >
          {t('community.olderHistory', 'Load earlier history')}
        </Button>
      )}
      {evidence !== null && (
        <div className="space-y-2">
          <h4 className="text-sm font-semibold">
            {t('community.capturedEvidence', 'Captured public evidence')}
          </h4>
          <pre className="max-h-96 overflow-auto rounded-lg border border-border p-4 text-xs scrollbar-sleek">
            {JSON.stringify(evidence, null, 2)}
          </pre>
          <Button variant="ghost" onClick={() => setEvidence(null)}>
            {t('community.closeEvidence', 'Close evidence')}
          </Button>
        </div>
      )}
      {detail.sourceHistory.map((record) => (
        <div key={record.id} className="rounded-lg border border-border p-4 text-xs">
          <p>
            {new Date(record.observedAt).toLocaleString(locale)} · {record.state}
          </p>
          <code className="mt-2 block break-all">{record.headSha}</code>
          <p className="mt-2 break-all text-2xs text-muted-foreground">
            {t('community.digestAlgorithm', 'SHA-256')} {record.id}
          </p>
        </div>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  )
}
