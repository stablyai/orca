import { TriangleAlert } from 'lucide-react'
import type React from 'react'
import { useEffect, useId, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../ui/button'
import { Skeleton } from '../ui/skeleton'
import type { RecipeForwardedEnvSummary } from '../../../../shared/ephemeral-vm-recipe-forwarded-env'

const NAMES_IN_LINE = 3

/**
 * P-4 (agent accounts spec §4, Q9): recipe create scripts get this computer's environment, or only
 * what the recipe's passEnv allows (`summary.narrowed`). A warning only; names, never values.
 * `summary` null while loading, undefined when unavailable.
 */
export function RecipeEnvForwardingWarning({
  summary,
  defaultReviewOpen = false
}: {
  summary: RecipeForwardedEnvSummary | null | undefined
  defaultReviewOpen?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const listId = useId()
  const [reviewOpen, setReviewOpen] = useState(defaultReviewOpen)
  const keyLike = summary?.keyLike ?? []
  const names =
    keyLike.slice(0, NAMES_IN_LINE).join(', ') + (keyLike.length > NAMES_IN_LINE ? ', …' : '')
  const detail = !summary
    ? null
    : keyLike.length === 0
      ? t(
          'agentHostPanel.recipeEnvDetailNoKeys',
          '{{count}} variables, none that look like keys. The recipe decides what reaches the VM.',
          {
            count: summary.count,
            defaultValue_one:
              '{{count}} variable, none that look like keys. The recipe decides what reaches the VM.'
          }
        )
      : keyLike.length === 1
        ? t(
            'agentHostPanel.recipeEnvDetailOneKey',
            '{{count}} variables, including 1 that looks like a key ({{names}}). The recipe decides what reaches the VM.',
            {
              count: summary.count,
              names,
              defaultValue_one:
                '{{count}} variable, including 1 that looks like a key ({{names}}). The recipe decides what reaches the VM.'
            }
          )
        : t(
            'agentHostPanel.recipeEnvDetail',
            '{{count}} variables, including {{keys}} that look like keys ({{names}}). The recipe decides what reaches the VM.',
            {
              count: summary.count,
              keys: keyLike.length,
              names,
              defaultValue_one:
                '{{count}} variable, including {{keys}} that look like keys ({{names}}). The recipe decides what reaches the VM.'
            }
          )

  return (
    <div
      role="note"
      aria-busy={summary === null}
      className="rounded-lg border border-status-warning-border bg-status-warning-background px-3 py-2.5 text-xs leading-5"
    >
      <div className="flex items-start gap-2.5">
        <TriangleAlert className="mt-0.5 size-4 shrink-0 text-status-warning" aria-hidden />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="text-sm font-medium text-foreground">
            {summary?.narrowed
              ? t(
                  'agentHostPanel.recipeEnvNarrowed',
                  "This recipe's create script gets only the variables its passEnv allows."
                )
              : t(
                  'agentHostPanel.recipeEnv',
                  "This recipe's create script gets this computer's environment."
                )}
          </p>
          {summary === null ? (
            <Skeleton className="h-3.5 w-4/5" shape="small" />
          ) : detail ? (
            <p className="text-muted-foreground">{detail}</p>
          ) : null}
        </div>
        {summary ? (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="shrink-0"
            aria-expanded={reviewOpen}
            aria-controls={listId}
            onClick={() => setReviewOpen((open) => !open)}
          >
            {reviewOpen
              ? t('agentHostPanel.recipeEnvHide', 'Hide')
              : t('agentHostPanel.recipeEnvReview', 'Review')}
          </Button>
        ) : null}
      </div>
      {summary && reviewOpen ? (
        <div id={listId} className="scrollbar-sleek mt-2 max-h-56 space-y-2 overflow-y-auto pl-6.5">
          <ForwardedNameGroup
            label={t('agentHostPanel.recipeEnvKeyLike', 'Look like keys')}
            names={summary.keyLike}
          />
          <ForwardedNameGroup
            label={t('agentHostPanel.recipeEnvOther', 'Other variables')}
            names={summary.other}
          />
        </div>
      ) : null}
    </div>
  )
}

function ForwardedNameGroup({
  label,
  names
}: {
  label: string
  names: string[]
}): React.JSX.Element | null {
  const headingId = useId()
  if (names.length === 0) {
    return null
  }
  return (
    <section aria-labelledby={headingId}>
      <h4 id={headingId} className="font-medium text-foreground">
        {label}
      </h4>
      <ul className="font-mono text-muted-foreground">
        {names.map((name) => (
          <li key={name} className="break-all">
            {name}
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Loads the names from main; recipe scripts run there, so this computer is main's process env. */
export function RecipeEnvForwardingNotice(): React.JSX.Element {
  const [summary, setSummary] = useState<RecipeForwardedEnvSummary | null | undefined>(null)
  useEffect(() => {
    let live = true
    void (async () => {
      try {
        const next = await window.api.ephemeralVm.forwardedEnvSummary()
        if (live) {
          setSummary(next)
        }
      } catch {
        // Older main or web client: the warning still stands, without the counts.
        if (live) {
          setSummary(undefined)
        }
      }
    })()
    return () => {
      live = false
    }
  }, [])
  return <RecipeEnvForwardingWarning summary={summary} />
}
