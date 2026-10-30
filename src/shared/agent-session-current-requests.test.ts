import { expect, it } from 'vitest'
import {
  applyCurrentRequestsMarker,
  currentMessageQuestionView
} from './agent-session-current-requests'
import { messageQuestionFixture } from './message-question-occurrence.test-fixture'
import {
  EMPTY_STRUCTURED_AGENT_SESSION,
  reduceStructuredAgentSession
} from './structured-agent-session-reducer'
import type { AgentSessionCurrentRequestsMarker } from './agent-session-current-requests-wire'

const marker: AgentSessionCurrentRequestsMarker = {
  contract: 'agent-session.current-requests.v2',
  sessionId: 'chat',
  epoch: 'journal-epoch',
  publisher: 'publisher-one',
  revision: 1,
  owner: 'publisher-one:canonical-source',
  version: 'one'
}

it('installs only a matching complete publication, retaining disabled same-source records during replacement', () => {
  const records = [messageQuestionFixture('host-address')]
  let state = reduceStructuredAgentSession(EMPTY_STRUCTURED_AGENT_SESSION, {
    type: 'requests-marker',
    marker
  })
  expect(state.asyncQuestions).toBeUndefined()
  expect(currentMessageQuestionView(state)).toEqual({ records: [], ready: false })
  const payload = {
    blocking: [],
    asyncQuestions: records,
    context: { sessionId: 'chat', boundary: 'root' }
  }
  state = reduceStructuredAgentSession(state, {
    type: 'requests-complete',
    marker,
    items: [],
    payload
  })
  expect(currentMessageQuestionView(state)).toEqual({ records, ready: true })
  const replacement = {
    ...marker,
    publisher: 'publisher-two',
    owner: 'publisher-two:canonical-source',
    version: 'two'
  }
  state = reduceStructuredAgentSession(state, { type: 'requests-marker', marker: replacement })
  expect(currentMessageQuestionView(state)).toEqual({ records, ready: false })
  state = reduceStructuredAgentSession(state, {
    type: 'requests-complete',
    marker,
    items: [],
    payload: { ...payload, asyncQuestions: [] }
  })
  expect(currentMessageQuestionView(state)).toEqual({ records, ready: false })
  state = reduceStructuredAgentSession(state, {
    type: 'requests-complete',
    marker: replacement,
    items: [],
    payload: { ...payload, asyncQuestions: [] }
  })
  expect(currentMessageQuestionView(state)).toEqual({ records: [], ready: true })
})

it.each(['epoch', 'sessionId'] as const)('cannot retain controls from a different %s', (field) => {
  const records = [messageQuestionFixture('other-source-question')]
  const state = { asyncQuestions: records, requestMarker: marker, requestAuthority: marker }
  const other = {
    ...marker,
    publisher: 'new-publisher',
    owner: 'new-publisher:canonical-source',
    version: 'two',
    [field]: 'different'
  }
  const next = applyCurrentRequestsMarker(state, other)
  expect(next.asyncQuestions).toBeUndefined()
  expect(next.requestAuthority).toBeUndefined()
  expect(currentMessageQuestionView(next)).toEqual({ records: [], ready: false })
})

it('keeps same-resource message controls disabled across a provider fence change while dropping live blocking controls', () => {
  const records = [messageQuestionFixture('durable-question')]
  const next = applyCurrentRequestsMarker(
    { asyncQuestions: records, requestMarker: marker, requestAuthority: marker },
    { ...marker, owner: 'publisher-one:new-fence', revision: 2, version: 'two' }
  )
  expect(currentMessageQuestionView(next)).toEqual({ records, ready: false })
  expect(next.currentRequests).toEqual([])
})
