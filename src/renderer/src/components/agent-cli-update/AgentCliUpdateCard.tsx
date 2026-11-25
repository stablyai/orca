import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { useTranslate } from '@/i18n/use-translate'
import {
  agentCliUpdateStartable,
  runAgentCliUpdateRow
} from '../status-bar/updates/AgentCliUpdateList'
import {
  agentCliUpdateCardWait,
  agentCliUpdateOfferKey,
  readAgentCliUpdateCardMemory,
  writeAgentCliUpdateCardMemory,
  type AgentCliUpdateCardMemory
} from './agent-cli-update-card-offer'
import { rowFor, targetPhase, type RunTarget } from './agent-cli-update-card-run'
import { AgentCliUpdateCardOffer } from './AgentCliUpdateCardOffer'
import { AgentCliUpdateCardStrip } from './AgentCliUpdateCardStrip'
import { useAgentCliUpdateGroups } from './use-agent-cli-update-groups'

// Same pause as Orca's "you're up to date" card before it leaves on its own.
const DONE_HIDE_MS = 3000
const EXIT_MS = 150

/** An Update all run, with the releases its offer showed; only those count as seen when it closes. */
type RunSession = { targets: readonly RunTarget[]; shownKeys: readonly string[] }

/** Bottom-right offer to update the user's own agent CLIs; Update all collapses it to a progress strip. */
export function AgentCliUpdateCard(): React.JSX.Element | null {
  const t = useTranslate()
  const groups = useAgentCliUpdateGroups()
  const prefersReducedMotion = usePrefersReducedMotion()
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const offerKeys = useMemo(() => rows.flatMap((row) => agentCliUpdateOfferKey(row) ?? []), [rows])
  const [memory, setMemory] = useState<AgentCliUpdateCardMemory>(readAgentCliUpdateCardMemory)
  const [clock, setClock] = useState(() => Date.now())
  const [session, setSession] = useState<RunSession | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [exiting, setExiting] = useState(false)
  const exitTimer = useRef<number | null>(null)

  const wait = agentCliUpdateCardWait(offerKeys, memory, clock)
  const targets = session?.targets ?? []
  const phases = targets.map((target) => targetPhase(target, rows))
  const view =
    session === null
      ? 'offer'
      : phases.includes('running')
        ? 'updating'
        : phases.includes('failed')
          ? 'failed'
          : 'done'
  const offerRows = rows.filter((row) => row.update !== null)
  const visible = view !== 'offer' || (offerRows.length > 0 && wait === 0)

  // Wakes the card once its daily wait is over; reads the real clock in case `clock` went stale.
  useEffect(() => {
    if (wait === null || wait === 0) {
      return
    }
    const timer = window.setTimeout(
      () => setClock(Date.now()),
      agentCliUpdateCardWait(offerKeys, memory, Date.now()) ?? 0
    )
    return () => window.clearTimeout(timer)
  }, [wait, offerKeys, memory])

  const close = useCallback(
    (shownKeys: readonly string[]): void => {
      const finish = (): void => {
        exitTimer.current = null
        const next = { closedAt: Date.now(), seen: shownKeys }
        writeAgentCliUpdateCardMemory(next)
        setMemory(next)
        setClock(next.closedAt)
        setSession(null)
        setDetailsOpen(false)
        setExiting(false)
      }
      if (prefersReducedMotion) {
        finish()
        return
      }
      if (exitTimer.current === null) {
        setExiting(true)
        exitTimer.current = window.setTimeout(finish, EXIT_MS)
      }
    },
    [prefersReducedMotion]
  )
  useEffect(
    () => () => {
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current)
      }
    },
    []
  )

  const sessionShownKeys = session?.shownKeys
  useEffect(() => {
    if (view !== 'done' || !sessionShownKeys) {
      return
    }
    const timer = window.setTimeout(() => close(sessionShownKeys), DONE_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [view, close, sessionShownKeys])

  if (!visible) {
    return null
  }

  const startable = offerRows.filter(agentCliUpdateStartable)
  const hostLabels = new Map(groups.map((group) => [group.hostKey, group.label]))
  const startAll = (): void => {
    setSession({
      shownKeys: offerKeys,
      targets: startable.flatMap((row) =>
        row.update
          ? [
              {
                hostKey: row.hostKey,
                hostLabel: hostLabels.get(row.hostKey) ?? null,
                agent: row.agent,
                from: row.update.installedVersion,
                to: row.update.latestVersion
              }
            ]
          : []
      )
    })
    setDetailsOpen(false)
    startable.forEach(runAgentCliUpdateRow)
  }
  const retryFailed = (): void => {
    targets.forEach((target, index) => {
      const row = rowFor(target, rows)
      if (phases[index] === 'failed' && row) {
        runAgentCliUpdateRow(row)
      }
    })
  }
  const closeShown = (): void => close(session?.shownKeys ?? offerKeys)
  // Scoped to the card like Orca's update card: a global Escape would also fire for terminals and chats.
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
    if (view === 'updating') {
      setDetailsOpen(false)
    } else {
      closeShown()
    }
  }

  return (
    <div
      className={
        prefersReducedMotion
          ? undefined
          : exiting
            ? 'animate-update-card-exit'
            : 'animate-update-card-enter'
      }
    >
      <Card
        size="notice"
        role="complementary"
        aria-label={t('agentCliUpdate.cardLabel', 'Agent CLI updates')}
        onKeyDown={onKeyDown}
        className="overflow-hidden"
      >
        {view === 'offer' ? (
          <AgentCliUpdateCardOffer
            groups={groups}
            offerRows={offerRows}
            startable={startable}
            detailsOpen={detailsOpen}
            onToggleDetails={() => setDetailsOpen((open) => !open)}
            onUpdate={startAll}
            onClose={closeShown}
          />
        ) : (
          <AgentCliUpdateCardStrip
            view={view}
            targets={targets}
            phases={phases}
            rows={rows}
            detailsOpen={detailsOpen || view === 'failed'}
            onToggleDetails={() => setDetailsOpen((open) => !open)}
            onRetry={retryFailed}
            onClose={closeShown}
          />
        )}
      </Card>
    </div>
  )
}
