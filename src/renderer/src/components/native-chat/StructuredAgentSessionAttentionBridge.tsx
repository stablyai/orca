import { useEffect, useMemo, useRef } from 'react'
import { useShallow } from 'zustand/react/shallow'
import {
  registerAgentSubjectReadCapture,
  subscribeAgentSubjectReads,
  sameStructuredReadTarget,
  type StructuredSubjectRead
} from '@/attention/agent-subject-read-actions'
import { findStructuredAgentSessionReadOwner } from './structured-agent-session-read-owner'
import { structuredAttentionReadObservation } from './structured-attention-read-observation'
import { useAppStore } from '@/store'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import {
  structuredAgentSessionOwnerForTab,
  structuredAgentSessionTargetForHost
} from '@/runtime/structured-agent-session-owner'
import { getStructuredAgentSessionTurnCompletionFeed } from '@/runtime/structured-agent-session-turn-completion-feed'
import { getStructuredAgentSessionStatusFeed } from '@/runtime/structured-agent-session-status-feed'
import { acknowledgeStructuredAgentSessionAttention } from '@/runtime/structured-agent-session-client'
import type { AgentJournalCursor } from '../../../../shared/agent-session-journal-types'
import type { AgentSessionExecutionLocation } from '../../../../shared/agent-session-record'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session-wire'
import { structuredAgentSessionPaneKey } from '../../../../shared/structured-agent-session-projection'
import {
  dispatchStructuredPromptAttention,
  dispatchStructuredTurnCompletionAttention
} from './structured-attention-dispatch'
import { getStructuredAgentSessionTabs, type StructuredTab } from './structured-agent-session-tabs'

/**
 * One subscription per open structured tab, so a finished or asking chat lights its unread
 * indicators whether or not its transcript is on screen, and reading it withdraws the phone alerts
 * its host pushed.
 *
 * Subscribing per tab rather than once per host is what makes this correct, not just convenient:
 * the tab IS the attention surface. A completion for a session with no open tab has no surface to
 * mark and no liveness evidence in this process, and the surface adapter would reject it anyway.
 */
function StructuredAgentSessionAttention({
  tab
}: {
  tab: StructuredTab
}): React.JSX.Element | null {
  // The same owner the chat pane and status bridge read, so all of them follow one host.
  const owner = useAppStore((state) => structuredAgentSessionOwnerForTab(state, tab))
  const target = useMemo(() => structuredAgentSessionTargetForHost(owner), [owner])
  return target ? <StructuredAgentSessionOwnedAttention tab={tab} target={target} /> : null
}

function StructuredAgentSessionOwnedAttention({
  tab,
  target
}: {
  tab: StructuredTab
  target: RuntimeClientTarget
}): null {
  const feed = useMemo(() => getStructuredAgentSessionTurnCompletionFeed(target), [target])
  useEffect(() => feed.activate(), [feed])
  const paneKey = structuredAgentSessionPaneKey(tab.id, tab.entityId)
  const readFrontier = useRef<StructuredSubjectRead | undefined>(undefined)
  // Where the newest edge this tab was handed sits in the journal: what lit its row.
  const surfaced = useRef<AgentJournalCursor | undefined>(undefined)
  // A remote prompt this desktop relayed to its phones, until the host says none is pending.
  const relayedPrompt = useRef<
    { scope: AgentSessionExecutionLocation; raisedAt: number } | undefined
  >(undefined)
  const settleRelayedPrompt = useRef<() => void>(() => {})
  useEffect(() => {
    let lastAttempt: { observationKey: string } | undefined
    const stopCapture = registerAgentSubjectReadCapture(paneKey, (intent) => {
      const state = findStructuredAgentSessionReadOwner(tab.entityId, target)?.getSnapshot().state
      const viewed = state?.cursor
        ? { cursor: state.cursor, observationKey: structuredAttentionReadObservation(state) }
        : undefined
      // Marking the row read covers what lit it, even unmounted or hidden; never a later edge.
      const edge = intent === 'explicit' ? surfaced.current : undefined
      const boundary =
        edge && (!viewed || isLaterCursor(edge, viewed.cursor))
          ? {
              cursor: edge,
              observationKey: `${viewed?.observationKey ?? ''}|edge:${edge.epoch}:${edge.sequence}`
            }
          : viewed
      if (!boundary) {
        return null
      }
      return {
        target,
        sessionId: tab.entityId,
        observedCursor: { ...boundary.cursor },
        observationKey: boundary.observationKey
      }
    })
    const stopRead = subscribeAgentSubjectReads((reads) => {
      const read = reads.find((entry) => entry.subjectKey === paneKey)?.structured
      if (
        !read ||
        read.sessionId !== tab.entityId ||
        !sameStructuredReadTarget(read.target, target)
      ) {
        return
      }
      const previous = readFrontier.current?.observedCursor
      if (
        previous?.epoch !== read.observedCursor.epoch ||
        previous.sequence < read.observedCursor.sequence
      ) {
        readFrontier.current = {
          ...read,
          observedCursor: { ...read.observedCursor }
        }
      }
      if (read.observationKey === lastAttempt?.observationKey) {
        return
      }
      const attempt = { observationKey: read.observationKey }
      lastAttempt = attempt
      const localRetirement = (async (): Promise<boolean> => {
        try {
          await window.api?.notifications?.dismiss?.(
            [],
            [paneKey],
            [{ paneKey, sessionId: read.sessionId, observedCursor: read.observedCursor }]
          )
          return true
        } catch (error) {
          console.warn('[structured-session-attention] local retirement failed', error)
          return false
        }
      })()
      void Promise.all([
        localRetirement,
        acknowledgeStructuredAgentSessionAttention(target, read.sessionId, read.observedCursor)
      ]).then((results) => {
        // An older result cannot release a newer read when the prompt set repeats.
        if (lastAttempt === attempt && results.some((succeeded) => !succeeded)) {
          lastAttempt = undefined
        }
      })
    })
    return () => {
      stopRead()
      stopCapture()
      readFrontier.current = undefined
      surfaced.current = undefined
    }
  }, [paneKey, tab.entityId, target])
  useEffect(
    () =>
      feed.subscribe((edge) => {
        const payload = edge.type === 'prompt' ? edge.prompt : edge.completion
        const cursor = payload.sessionId === tab.entityId ? payload.journalCursor : undefined
        if (cursor && (!surfaced.current || isLaterCursor(cursor, surfaced.current))) {
          surfaced.current = { ...cursor }
        }
        if (edge.type === 'prompt') {
          if (edge.prompt.sessionId === tab.entityId) {
            if (target.kind === 'environment') {
              relayedPrompt.current = {
                scope: edge.prompt.scope,
                raisedAt: Math.max(edge.prompt.raisedAt, relayedPrompt.current?.raisedAt ?? 0)
              }
            }
            dispatchStructuredPromptAttention(tab, edge.prompt, target, () => {
              const read = readFrontier.current
              return read?.sessionId === tab.entityId &&
                sameStructuredReadTarget(read.target, target)
                ? read
                : undefined
            })
            // Its own resolution may already be mirrored; the relay above is already in main.
            settleRelayedPrompt.current()
          }
        } else if (edge.completion.sessionId === tab.entityId) {
          dispatchStructuredTurnCompletionAttention(tab, edge.completion, target)
        }
      }),
    [feed, tab, target]
  )
  useEffect(() => {
    if (target.kind !== 'environment') {
      return undefined
    }
    // Separate sockets: settle on a live row dated after the prompt; updatedAt only rises per epoch.
    const status = getStructuredAgentSessionStatusFeed(target)
    let settling = false
    // A rejected settle is retried only once the mirror holds a different row.
    let rejectedRow: AgentSessionStatusSummary | undefined
    const settle = (): void => {
      const owed = relayedPrompt.current
      const summary = status.getSnapshot().get(tab.entityId)
      if (
        settling ||
        !owed ||
        !summary ||
        summary === rejectedRow ||
        summary.status === 'attention' ||
        summary.updatedAt <= owed.raisedAt ||
        status.getSessionObservation(tab.entityId) !== 'live'
      ) {
        return
      }
      settling = true
      void Promise.resolve(
        window.api?.notifications?.settleStructuredPrompts?.(owed.scope, tab.entityId)
      )
        .then(
          () => {
            // A prompt relayed meanwhile keeps its own claim.
            if (relayedPrompt.current === owed) {
              relayedPrompt.current = undefined
            }
          },
          (error: unknown) => {
            rejectedRow = summary
            console.warn('[structured-session-attention] relayed prompt settlement failed', error)
          }
        )
        .finally(() => {
          settling = false
          // Rows that landed during the call were skipped; judge the mirror as it is now.
          settle()
        })
    }
    settleRelayedPrompt.current = settle
    const stopListening = status.subscribe(settle)
    const release = status.activate()
    return () => {
      stopListening()
      release()
      settleRelayedPrompt.current = () => {}
      relayedPrompt.current = undefined
    }
  }, [tab.entityId, target])
  return null
}

/** Another epoch counts as later: rewinds re-mint the journal, and only edges are live news. */
function isLaterCursor(candidate: AgentJournalCursor, current: AgentJournalCursor): boolean {
  return candidate.epoch !== current.epoch || candidate.sequence > current.sequence
}

export function StructuredAgentSessionAttentionBridge(): React.JSX.Element {
  const tabs = useAppStore(
    useShallow((state) => getStructuredAgentSessionTabs(state.unifiedTabsByWorktree))
  )
  return (
    <>
      {tabs.map((tab) => (
        <StructuredAgentSessionAttention key={`${tab.id}:${tab.entityId}`} tab={tab} />
      ))}
    </>
  )
}
