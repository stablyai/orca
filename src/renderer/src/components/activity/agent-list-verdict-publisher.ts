import { useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import type {
  AgentListPublication,
  AgentListVerdict
} from '../../../../shared/agent-status/presentation/agent-list-status'
import { isClearableActivityThread } from './activity-clear-completed'
import { classifyChildAgents } from './activity-thread-child-agent'
import { activityThreadStatusId } from './activity-thread-presentation'
import type { AgentPaneThread } from './activity-thread-types'
import { useAllAgentPaneThreads } from './use-agent-pane-threads'

const PUBLISH_INTERVAL_MS = 250

/** The Agents list's verdict for every pane the window knows; a pane with no thread is unlisted. */
function buildAgentListVerdicts(
  threads: readonly AgentPaneThread[],
  knownPaneKeys: readonly string[]
): Record<string, AgentListVerdict> {
  const { parentPaneKeyByChild, hidden } = classifyChildAgents(threads)
  const verdicts: Record<string, AgentListVerdict> = {}
  for (const paneKey of knownPaneKeys) {
    verdicts[paneKey] = { listed: false }
  }
  for (const thread of threads) {
    const childOf = parentPaneKeyByChild.get(thread.paneKey)
    verdicts[thread.paneKey] = {
      listed: true,
      status: activityThreadStatusId(thread),
      unread: thread.unread,
      clearable: isClearableActivityThread(thread),
      sortAt: thread.latestTimestamp,
      title: thread.paneTitle,
      ...(childOf ? { childOf } : {}),
      ...(hidden.has(thread.paneKey) ? { foldedChild: true as const } : {})
    }
  }
  return verdicts
}

// One publisher per window; a paired client's change reads its threads and waits for its next publish.
let published: { threads: readonly AgentPaneThread[]; publication: AgentListPublication } | null =
  null
let requestRender: (() => void) | null = null
let waiters: ((publication: AgentListPublication) => void)[] = []
let lastSentVerdicts: string | null = null
let lastSentAt = 0
let timer: ReturnType<typeof setTimeout> | null = null

function send(publication: AgentListPublication): void {
  if (timer !== null) {
    clearTimeout(timer)
    timer = null
  }
  lastSentAt = Date.now()
  const verdicts = JSON.stringify(publication.verdicts)
  if (verdicts !== lastSentVerdicts) {
    lastSentVerdicts = verdicts
    window.api.agentStatus.publishListVerdicts?.(publication)
  }
}

/** The threads behind the last published verdicts; null until the publisher has run. */
export function readPublishedAgentPaneThreads(): readonly AgentPaneThread[] | null {
  return published?.threads ?? null
}

/** Resolves with the verdicts once the publisher has rendered the store as it is now. */
export function publishAgentListNow(): Promise<AgentListPublication> {
  const render = requestRender
  if (!render) {
    return Promise.reject(new Error('agent_activity_not_ready'))
  }
  return new Promise((resolve) => {
    waiters.push(resolve)
    render()
  })
}

/** Sends the desktop Agents list's verdicts to main, so worktree.ps shows paired clients the same list. */
export default function AgentListVerdictPublisher(): null {
  const ready = useAppStore((s) => s.persistedUIReady)
  // The unscoped list: view filters and the child-agent toggle only narrow what one surface shows.
  const { storeData, allThreads } = useAllAgentPaneThreads()
  const [renderRequest, setRenderRequest] = useState(0)
  useEffect(() => {
    requestRender = () => setRenderRequest((count) => count + 1)
    return () => {
      requestRender = null
      published = null
      lastSentVerdicts = null
      // Unmounted with no phone paired: stale verdicts would hide new agents from a later pairing.
      window.api.agentStatus.publishListVerdicts?.(null)
      if (timer !== null) {
        clearTimeout(timer)
        timer = null
      }
    }
  }, [])
  const verdicts = useMemo(
    () => buildAgentListVerdicts(allThreads, Array.from(storeData.agentStatusByPaneKey.keys())),
    [allThreads, storeData.agentStatusByPaneKey]
  )
  useEffect(() => {
    // Unhydrated read stamps would mark every agent unread.
    if (!ready) {
      return
    }
    const publication = { publishedAt: Date.now(), verdicts }
    published = { threads: allThreads, publication }
    const pending = waiters
    waiters = []
    if (pending.length > 0) {
      send(publication)
      for (const resolve of pending) {
        resolve(publication)
      }
      return
    }
    // Each run reschedules from the last send, so a busy store cannot starve the publish.
    const scheduled = setTimeout(
      () => published && send(published.publication),
      Math.max(0, lastSentAt + PUBLISH_INTERVAL_MS - Date.now())
    )
    timer = scheduled
    return () => {
      clearTimeout(scheduled)
      if (timer === scheduled) {
        timer = null
      }
    }
  }, [ready, allThreads, verdicts, renderRequest])
  return null
}
