import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Card } from '@/components/ui/card'
import { usePrefersReducedMotion } from '@/hooks/theme/usePrefersReducedMotion'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import {
  agentCliUpdateRows,
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

// Read from the store at close time, so a timer closing the card records what is listed then.
function listedOfferKeys(): string[] {
  return [...useAppStore.getState().agentCliUpdates].flatMap(([hostKey, host]) =>
    agentCliUpdateRows(hostKey, host).flatMap((row) => agentCliUpdateOfferKey(row) ?? [])
  )
}
/** Bottom-right offer to update the user's own agent CLIs; Update all collapses it to a progress strip. */
export function AgentCliUpdateCard(): React.JSX.Element | null {
  const t = useTranslate()
  const groups = useAgentCliUpdateGroups()
  const prefersReducedMotion = usePrefersReducedMotion()
  const rows = useMemo(() => groups.flatMap((group) => group.rows), [groups])
  const offerKeys = useMemo(() => rows.flatMap((row) => agentCliUpdateOfferKey(row) ?? []), [rows])
  const [memory, setMemory] = useState<AgentCliUpdateCardMemory>(readAgentCliUpdateCardMemory)
  const [clock, setClock] = useState(() => Date.now())
  const [targets, setTargets] = useState<readonly RunTarget[] | null>(null)
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [exiting, setExiting] = useState(false)
  const exitTimer = useRef<number | null>(null)
  const cardRef = useRef<HTMLDivElement>(null)
  const heightRef = useRef<number | null>(null)

  const wait = agentCliUpdateCardWait(offerKeys, memory, clock)
  const phases = targets?.map((target) => targetPhase(target, rows)) ?? []
  const view =
    targets === null
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

  const close = useCallback((): void => {
    const finish = (): void => {
      exitTimer.current = null
      const next = { closedAt: Date.now(), seen: listedOfferKeys() }
      writeAgentCliUpdateCardMemory(next)
      setMemory(next)
      setClock(next.closedAt)
      setTargets(null)
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
  }, [prefersReducedMotion])
  useEffect(
    () => () => {
      if (exitTimer.current !== null) {
        window.clearTimeout(exitTimer.current)
      }
    },
    []
  )

  useEffect(() => {
    if (view !== 'done') {
      return
    }
    const timer = window.setTimeout(close, DONE_HIDE_MS)
    return () => window.clearTimeout(timer)
  }, [view, close])

  // Tracks the card's height so a switch between offer and strip can ease from the old one.
  useEffect(() => {
    const card = cardRef.current
    if (!card) {
      heightRef.current = null
      return
    }
    const observer = new ResizeObserver(() => {
      heightRef.current = card.offsetHeight
    })
    observer.observe(card)
    return () => observer.disconnect()
  }, [visible])
  useLayoutEffect(() => {
    const card = cardRef.current
    const from = heightRef.current
    if (!card || from === null || prefersReducedMotion) {
      return
    }
    const to = card.offsetHeight
    if (from !== to) {
      card.animate([{ height: `${from}px` }, { height: `${to}px` }], {
        duration: 240,
        easing: 'cubic-bezier(0.23, 1, 0.32, 1)'
      })
    }
  }, [view, prefersReducedMotion])

  if (!visible) {
    return null
  }

  const startable = offerRows.filter(agentCliUpdateStartable)
  const startAll = (): void => {
    setTargets(
      startable.flatMap((row) =>
        row.update
          ? [
              {
                hostKey: row.hostKey,
                agent: row.agent,
                from: row.update.installedVersion,
                to: row.update.latestVersion
              }
            ]
          : []
      )
    )
    setDetailsOpen(false)
    startable.forEach(runAgentCliUpdateRow)
  }
  const retryFailed = (): void => {
    targets?.forEach((target, index) => {
      const row = rowFor(target, rows)
      if (phases[index] === 'failed' && row) {
        runAgentCliUpdateRow(row)
      }
    })
  }
  const onKeyDown = (event: React.KeyboardEvent): void => {
    if (event.key !== 'Escape') {
      return
    }
    event.preventDefault()
    if (view === 'updating') {
      setDetailsOpen(false)
    } else {
      close()
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
        ref={cardRef}
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
            onClose={close}
          />
        ) : (
          <AgentCliUpdateCardStrip
            view={view}
            targets={targets ?? []}
            phases={phases}
            rows={rows}
            detailsOpen={detailsOpen || view === 'failed'}
            onToggleDetails={() => setDetailsOpen((open) => !open)}
            onRetry={retryFailed}
            onClose={close}
          />
        )}
      </Card>
    </div>
  )
}
