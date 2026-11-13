import { useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import type { OrcaBillingEntitlement } from '../../../../shared/orca-billing'

/**
 * Where an overage change stands. `saving` lasts while the request is in flight and always ends:
 * in `saved` once billing accepts it (or the card already reads the new state), or in `error`.
 * It never outlives the request: a flag that stayed set after Turn off hid the Turn on button
 * behind a stuck "✓ Saving…" (OVERAGE-REENABLE).
 */
export type OverageSaveState = 'idle' | 'saving' | 'saved' | 'error'

/** What a pending change asks for; a null cap means billing's default (or, when off, none). */
export type OverageTarget = { optedIn: boolean; capCents: number | null }

export function overageMatches(
  overage: OrcaBillingEntitlement['overage'],
  target: OverageTarget
): boolean {
  if (overage.optedIn !== target.optedIn) {
    return false
  }
  return !target.optedIn || target.capCents === null || overage.spendCapCents === target.capCents
}

/**
 * Tracks one change from Save / Turn on / Turn off to its end. `busy` is the parent's request
 * flag and `failures` its failure count; `onFailure` runs (during render) when a change fails.
 */
export function useOverageSaveState({
  overage,
  busy,
  failures,
  onFailure
}: {
  overage: OrcaBillingEntitlement['overage']
  busy: boolean
  failures: number
  onFailure: () => void
}): {
  status: OverageSaveState
  begin: (target: OverageTarget) => void
  /** Back to no status, e.g. once the field is edited again (review M13). */
  clear: () => void
} {
  const [saveState, setSaveState] = useState<OverageSaveState>('idle')
  const [target, setTarget] = useState<OverageTarget | null>(null)
  // Whether the parent has reported the request in flight since this change began.
  const [sawBusy, setSawBusy] = useState(false)
  const [seenFailures, setSeenFailures] = useState(failures)
  // Render-time adjustment (no effect), so no frame shows a finished change as "Saving…".
  let status = saveState
  if (seenFailures !== failures) {
    setSeenFailures(failures)
    onFailure()
    if (status === 'saving') {
      status = 'error'
      setSaveState('error')
      setTarget(null)
    }
  } else if (status === 'saving') {
    if (busy) {
      if (!sawBusy) {
        setSawBusy(true)
      }
    } else if (sawBusy || (target !== null && overageMatches(overage, target))) {
      // The request finished without a failure, or the card already reads the new state.
      status = 'saved'
      setSaveState('saved')
      setTarget(null)
    }
  }
  return {
    status,
    begin: (next) => {
      setSaveState('saving')
      setSawBusy(false)
      setTarget(next)
    },
    clear: () => {
      if (status !== 'saving') {
        setSaveState('idle')
      }
    }
  }
}

/** One status for both views: a spinner while saving; the check only ever goes with "Saved". */
export function OverageSaveStatus({
  status
}: {
  status: OverageSaveState
}): React.JSX.Element | null {
  const t = useTranslate()
  if (status === 'idle') {
    return null
  }
  return (
    <span
      role="status"
      className={
        status === 'error'
          ? 'flex h-9 items-center gap-1 text-xs text-destructive'
          : 'flex h-9 items-center gap-1 text-xs text-muted-foreground'
      }
    >
      {status === 'saving' ? (
        <>
          <LoaderCircle className="size-3.5 animate-spin" aria-hidden />
          {t('auto.components.billing.capSaving', 'Saving…')}
        </>
      ) : status === 'saved' ? (
        <>
          <Check className="size-3.5" aria-hidden />
          {t('auto.components.billing.capSaved', 'Saved')}
        </>
      ) : (
        t('auto.components.billing.capNotSaved', 'Couldn’t save')
      )}
    </span>
  )
}
