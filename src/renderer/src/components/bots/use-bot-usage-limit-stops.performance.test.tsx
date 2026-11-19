// @vitest-environment happy-dom
// Guards the usage-limit stop derive (STA-16269): every mounted reader re-read every host session on
// each status event. The derive must scale with the host's sessions once, not with readers x events.
import { act, render } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { AgentSessionStatusSummary } from '../../../../shared/agent-session/agent-session-wire'
import type { StructuredAgentSessionStatusChange } from '@/runtime/native-chat/status/structured-agent-session-status-dispatch'
import { useBotUsageLimitStops } from './use-bot-usage-limit-stops'

const feed = vi.hoisted(() => {
  const state: {
    snapshot: Map<string, AgentSessionStatusSummary>
    listeners: Set<(change: StructuredAgentSessionStatusChange) => void>
    owner: unknown
    cutReads: number
  } = { snapshot: new Map(), listeners: new Set(), owner: null, cutReads: 0 }
  return state
})

// Each measurement gets its own host feed, so no derive carries over between them.
vi.mock('@/runtime/native-chat/status/structured-agent-session-status-feed', () => ({
  getStructuredAgentSessionStatusFeed: () => feed.owner
}))

function newFeedOwner() {
  return {
    activate: () => () => {},
    getSnapshot: () => feed.snapshot,
    subscribe: (listener: (change: StructuredAgentSessionStatusChange) => void) => {
      feed.listeners.add(listener)
      return () => feed.listeners.delete(listener)
    }
  }
}

const NOW = 1_800_000_000_000
const RESET = NOW + 3_600_000
const HOME = 'home'
const READERS = 12

/** A summary that counts reads of its usage-limit cut, the field every stop derive starts from. */
function summary(
  sessionId: string,
  workspaceId: string,
  cut?: AgentSessionStatusSummary['usageLimitContinue']
): AgentSessionStatusSummary {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the stop reads only these fields.
  return {
    sessionId,
    workspaceId,
    agent: 'claude',
    conversationName: sessionId,
    get usageLimitContinue() {
      feed.cutReads++
      return cut
    }
  } as AgentSessionStatusSummary
}

function emit(change: StructuredAgentSessionStatusChange): void {
  act(() => feed.listeners.forEach((listener) => listener(change)))
}

const workspaces = [HOME]

function Reader() {
  return <span>{useBotUsageLimitStops({ hostId: 'local' }, workspaces).length}</span>
}

/** Mounts the readers over `sessions` host sessions, then counts cut reads per kind of event. */
function measure(sessions: number): {
  mount: number
  perStatusEvent: number
  wholeHost: number
  stops: string | null
} {
  feed.owner = newFeedOwner()
  feed.snapshot = new Map()
  feed.snapshot.set(
    'stopped',
    summary('stopped', HOME, { turnItemId: 't', resetsAt: RESET, state: 'off' })
  )
  for (let index = 0; index < sessions; index++) {
    feed.snapshot.set(`s${index}`, summary(`s${index}`, `w${index}`))
  }
  feed.cutReads = 0
  const view = render(
    <>
      {Array.from({ length: READERS }, (_, index) => (
        <Reader key={index} />
      ))}
    </>
  )
  const mount = feed.cutReads
  feed.cutReads = 0
  for (let event = 0; event < 10; event++) {
    const sessionId = `s${event}`
    feed.snapshot.set(sessionId, summary(sessionId, `w${event}`))
    emit(new Set([sessionId]))
  }
  const perStatusEvent = feed.cutReads / 10
  feed.cutReads = 0
  emit(null)
  const wholeHost = feed.cutReads
  const stops = view.container.textContent
  view.unmount()
  return { mount, perStatusEvent, wholeHost, stops }
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW })
})

afterEach(() => {
  feed.listeners.clear()
  vi.useRealTimers()
})

it('derives usage-limit stops once per host change, whatever the readers and sessions', () => {
  expect(measure(100)).toEqual({
    mount: 205,
    perStatusEvent: 1,
    wholeHost: 103,
    stops: '111111111111'
  })
  expect(measure(1000)).toEqual({
    mount: 2005,
    perStatusEvent: 1,
    wholeHost: 1003,
    stops: '111111111111'
  })
})
