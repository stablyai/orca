// @vitest-environment happy-dom
import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'

import { useAgentMessageSenderView } from './native-chat-agent-message-sender-view'

import { initialStore, resetSenderStore, status } from './native-chat-agent-sender.test-fixture'
import {
  agentSenderPublicationPatch,
  selectAgentSenderAssociation,
  resolveAgentMessageSender
} from '@/runtime/agent-sender-associations'
import type { AgentSenderPublication } from '../../../../shared/agent-sender-associations'
import type { AgentMessageSender } from '../../../../shared/agent-session/agent-session-message-source'

import { testOrcaSessionId } from '../../../../shared/orca-session-address-test-fixture'

let revision = 0
/** Each delivery is the host's next revision, as a publishing host stamps it. */
const publication = (
  associations: AgentSenderPublication['associations'] = []
): AgentSenderPublication => ({
  associations,
  principals: [],
  attachments: [],
  revision: { epoch: 'host', revision: ++revision }
})
const association = (i: number) => ({
  identity: `term_${i}`,
  paneKey: status(i).paneKey,
  worktreeId: 'workspace'
})
// A federated sender is named by its Dispatch address; any other by the handle it sent from.
const sender = (identity: string): AgentMessageSender =>
  identity.startsWith('dispatch:')
    ? { party: { address: identity, terminalHandle: null, orcaSessionId: null }, name: 'Sender' }
    : {
        party: { address: identity, terminalHandle: identity, orcaSessionId: null },
        name: 'Sender',
        agent: 'claude'
      }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(2_000_000)
  resetSenderStore()
})
afterEach(() => {
  cleanup()
  useAppStore.setState(initialStore, true)
  vi.useRealTimers()
})
it('qualifies federation by both execution peer and the attachment home principal', () => {
  const home = {
    ...publication(),
    principals: [{ peerFingerprint: 'execution', homePeerFingerprint: 'home-a' }]
  }
  useAppStore.setState({
    agentSenderPublicationsByHost: {
      local: { '*': home },
      'runtime:remote': {
        workspace: {
          ...publication(),
          peerFingerprint: 'execution',
          attachments: [
            { ...association(0), identity: 'dispatch:same', homePeerFingerprint: 'home-b' }
          ]
        }
      }
    }
  })
  const read = () =>
    selectAgentSenderAssociation(useAppStore.getState(), 'local', sender('dispatch:same'))
  expect(read()).toBeUndefined()
  useAppStore.setState(
    agentSenderPublicationPatch(useAppStore.getState(), 'runtime:remote', 'workspace', {
      ...publication(),
      peerFingerprint: 'execution',
      attachments: [{ ...association(0), identity: 'dispatch:same', homePeerFingerprint: 'home-a' }]
    })
  )
  // The attachment is qualified by its principals, but has no exact launch proof.
  expect(read()).toBeUndefined()
  expect(
    renderHook(() =>
      useAgentMessageSenderView({ ...sender('dispatch:same'), agent: 'codex' }, 'workspace', {
        kind: 'local'
      })
    ).result.current
  ).toEqual({ agentType: 'codex' })
  // The same execution peer reached as a second host makes the match ambiguous, not a pick.
  useAppStore.setState(
    agentSenderPublicationPatch(useAppStore.getState(), 'runtime:other', 'workspace', {
      ...publication(),
      peerFingerprint: 'execution',
      attachments: [{ ...association(1), identity: 'dispatch:same', homePeerFingerprint: 'home-a' }]
    })
  )
  expect(read()).toBeUndefined()
  expect(
    resolveAgentMessageSender(useAppStore.getState(), 'local', sender('dispatch:same'))
  ).toEqual({ kind: 'ambiguous' })
  for (const [index, host] of ['runtime:remote', 'runtime:other'].entries()) {
    useAppStore.setState(
      agentSenderPublicationPatch(useAppStore.getState(), host, 'workspace', {
        ...publication(),
        peerFingerprint: 'execution',
        attachments: [
          { ...association(index), identity: 'dispatch:same', homePeerFingerprint: 'home-b' }
        ]
      })
    )
  }
  expect(
    resolveAgentMessageSender(useAppStore.getState(), 'local', sender('dispatch:same')).kind
  ).toBe('gone')
})

it('keeps equal session ids on two hosts separate and rejects an unqualified pane collision', () => {
  const sessionId = testOrcaSessionId('11111111-1111-4111-8111-111111111111')
  const identity = {
    ...sender(`orca_session_id:${sessionId}`),
    party: {
      address: `orca_session_id:${sessionId}`,
      terminalHandle: null,
      orcaSessionId: sessionId
    }
  }
  const row = {
    identity: identity.party.address,
    paneKey: 'canonical',
    sessionId,
    worktreeId: 'workspace'
  }
  useAppStore.setState({
    agentSenderPublicationsByHost: {
      local: { '*': publication([row]) },
      'runtime:remote': { workspace: publication([row]) }
    }
  })
  expect(selectAgentSenderAssociation(useAppStore.getState(), 'local', identity)).toBeUndefined()
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', identity)
  ).toBeUndefined()
  useAppStore.setState(
    agentSenderPublicationPatch(
      useAppStore.getState(),
      'runtime:remote',
      'workspace',
      publication([{ ...row, paneKey: 'remote-pane' }])
    )
  )
  expect(selectAgentSenderAssociation(useAppStore.getState(), 'local', identity)?.paneKey).toBe(
    'canonical'
  )
  expect(
    selectAgentSenderAssociation(useAppStore.getState(), 'runtime:remote', identity)?.paneKey
  ).toBe('remote-pane')
})
