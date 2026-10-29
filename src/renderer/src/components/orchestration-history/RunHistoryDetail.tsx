import { useCallback, useEffect, useRef, useState } from 'react'
import type { RunEvent } from '../../../../shared/orchestration-run-events'
import { runtimeTargetForOwnerEnvironment } from '@/runtime/runtime-client-target'
import { openOrchestrationAddress } from '@/lib/open-agent-message-sender'
import { loadHistoryEvents, type HistoryRun } from './run-history-client'
import { useRunHistoryPages } from './use-run-history-pages'
import { RunHistoryTimeline } from './RunHistoryTimeline'

export function RunHistoryDetail({
  environmentId,
  run,
  onBack,
  onReveal
}: {
  environmentId: string | null
  run: HistoryRun
  onBack: () => void
  onReveal: () => void
}) {
  const load = useCallback(
    (cursor: string | undefined, signal: AbortSignal) =>
      loadHistoryEvents(environmentId, run.id, cursor, signal),
    [environmentId, run.id]
  )
  const page = useRunHistoryPages(load)
  const [openingSequence, setOpeningSequence] = useState<number | null>(null)
  const [openingVisible, setOpeningVisible] = useState(false)
  const mounted = useRef(true)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      clearTimeout(timer.current)
    }
  }, [])
  const openAgent = async (event: RunEvent) => {
    const address = event.dispatchId ? `dispatch:${event.dispatchId}` : event.data.coordinator
    if (!address || openingSequence !== null) {
      return
    }
    setOpeningSequence(event.sequence)
    timer.current = setTimeout(() => setOpeningVisible(true), 200)
    try {
      if (
        (await openOrchestrationAddress(
          address,
          runtimeTargetForOwnerEnvironment(environmentId)
        )) &&
        mounted.current
      ) {
        onReveal()
      }
    } finally {
      clearTimeout(timer.current)
      if (mounted.current) {
        setOpeningSequence(null)
        setOpeningVisible(false)
      }
    }
  }
  return (
    <RunHistoryTimeline
      run={run}
      page={page}
      onBack={onBack}
      onRefresh={page.refresh}
      onRetry={page.retry}
      onLoadMore={page.loadMore}
      onOpenAgent={(event) => void openAgent(event)}
      openingSequence={openingSequence}
      openingVisible={openingVisible}
    />
  )
}
