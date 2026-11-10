// R2's Set up: runs S0's one-time setup for each agent in turn, inside the build sheet's row.
// Main owns each setup; this only starts the next agent once the previous one is stored.
import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  OrcaCloudAccountAgent,
  OrcaCloudAgentSetups
} from '../../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'

export function useInlineSetupQueue(setups: OrcaCloudAgentSetups): {
  queue: readonly OrcaCloudAccountAgent[]
  run: (agents: readonly OrcaCloudAccountAgent[]) => void
  cancel: (agent: OrcaCloudAccountAgent) => void
  /** Stops the queue without touching main (a dismissed failure). */
  clear: () => void
} {
  const [queue, setQueue] = useState<readonly OrcaCloudAccountAgent[]>([])
  const [cursor, setCursor] = useState(0)
  // Set once the current agent's setup has left idle, so idle afterwards means it finished.
  const started = useRef(false)

  const start = useCallback((agent: OrcaCloudAccountAgent) => {
    started.current = false
    void window.api.orcaCloudAgents?.start({ agent })
  }, [])

  const run = useCallback(
    (agents: readonly OrcaCloudAccountAgent[]) => {
      const [first] = agents
      if (!first) {
        return
      }
      setQueue(agents)
      setCursor(0)
      start(first)
    },
    [start]
  )

  const cancel = useCallback((agent: OrcaCloudAccountAgent) => {
    setQueue([])
    void window.api.orcaCloudAgents?.cancel({ agent })
  }, [])

  const clear = useCallback(() => setQueue([]), [])

  const current = queue[cursor]
  const phase = current ? setups[current].phase : 'idle'
  useEffect(() => {
    if (!current) {
      return
    }
    if (phase === 'failed') {
      // Try again restarts from this agent; the ones after it wait.
      if (cursor > 0) {
        setQueue(queue.slice(cursor))
        setCursor(0)
      }
      return
    }
    if (phase !== 'idle') {
      started.current = true
      return
    }
    if (!started.current) {
      return
    }
    const next = queue[cursor + 1]
    setCursor(cursor + 1)
    if (next) {
      start(next)
    } else {
      setQueue([])
    }
  }, [current, phase, queue, cursor, start])

  return { queue, run, cancel, clear }
}
