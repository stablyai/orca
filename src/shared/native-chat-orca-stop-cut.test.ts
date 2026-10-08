import { describe, expect, it } from 'vitest'
import { agentSessionFailureFact } from './agent-session-failure'
import { agentSessionFailureWords } from './agent-session-failure-words'
import { readAgentSessionOrcaStop } from './agent-session-orca-stop'
import { agentJournalItemKey } from './agent-session-journal-item-key'
import type { AgentJournalRenderItem, AgentJournalTurnOutcome } from './agent-session-journal-types'
import { withNativeChatCutTurnNotices } from './native-chat-cut-turn-notice'
import {
  latestNativeChatOrcaStopCut,
  orcaShutdownRowClientMessageId
} from './native-chat-orca-stop-cut'

const LEGACY_TEXT =
  'Codex stopped while this response was in progress. You can continue in this conversation.'

const turnId = agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cut', ordinal: 1 })

function userMessage(sequence: number): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({ provider: 'orca', clientMessageId: `user-${sequence}` }),
    revision: 1,
    sequence,
    observedAt: sequence,
    body: { kind: 'message', role: 'user', blocks: [{ type: 'text', text: 'go' }] }
  }
}

function cutTurn(outcome?: AgentJournalTurnOutcome): AgentJournalRenderItem {
  return {
    itemId: turnId,
    revision: 2,
    sequence: 2,
    observedAt: 2,
    body: {
      kind: 'turn',
      turnId: 'cut',
      state: 'interrupted',
      startedAt: 1,
      completedAt: 5,
      ...(outcome ? { outcome } : {})
    }
  }
}

/** The host's row as a host that still wrote the agent's words stored it: those words and fact, and
 *  the cause beside them. */
function stopRow(orcaStop: { cause: string } | undefined, scoped = true): AgentJournalRenderItem {
  return {
    itemId: agentJournalItemKey({
      provider: 'orca',
      clientMessageId: orcaShutdownRowClientMessageId('session-1', 3, 'gen-1')
    }),
    revision: 1,
    sequence: 3,
    observedAt: 6,
    body: {
      kind: 'status',
      ...agentSessionFailureWords(agentSessionFailureFact('providerExited'), {
        agentName: 'Codex',
        surface: 'row'
      }),
      tone: 'error',
      ...(orcaStop === undefined ? {} : { orcaStop })
    },
    ...(scoped ? { turnScope: { kind: 'turn' as const, turnItemId: turnId } } : {})
  }
}

const update = { cause: 'update' }

describe('the cause on a stopped row', () => {
  it('is read when known and dropped when a newer host names one this build does not know', () => {
    expect(readAgentSessionOrcaStop(update)).toEqual({ cause: 'update' })
    expect(readAgentSessionOrcaStop({ cause: 'power-loss' })).toBeUndefined()
  })

  it("rides beside today's sentence, so a client that reads no cause prints the same row", () => {
    expect(stopRow(update).body).toMatchObject({ text: LEGACY_TEXT, tone: 'error' })
  })
})

describe('the transcript reader', () => {
  it("reads the host row as the cut turn's one explanation and adds none of its own", () => {
    const items = [userMessage(1), cutTurn(), stopRow(update)]
    const read = withNativeChatCutTurnNotices(items)
    expect(read.filter((item) => item.body.kind === 'status')).toHaveLength(1)
  })
})

describe('the cut Continue answers', () => {
  it('is the latest turn when an Orca stop cut it and nothing was sent since', () => {
    expect(latestNativeChatOrcaStopCut([userMessage(1), cutTurn(), stopRow(update)], [])).toEqual({
      turnItemId: turnId,
      cause: 'update'
    })
  })

  it('is gone once a message follows the cut', () => {
    expect(
      latestNativeChatOrcaStopCut([userMessage(1), cutTurn(), stopRow(update), userMessage(4)], [])
    ).toBeNull()
  })

  it('stays for a steer the cut turn took, which asked for nothing new', () => {
    const steer: AgentJournalRenderItem = {
      ...userMessage(4),
      turnScope: { kind: 'turn', turnItemId: turnId }
    }
    expect(
      latestNativeChatOrcaStopCut([userMessage(1), cutTurn(), stopRow(update), steer], [])
    ).toEqual({ turnItemId: turnId, cause: 'update' })
  })

  it('stays across a conversation command run after the cut, and its turn', () => {
    const command: AgentJournalRenderItem = {
      ...userMessage(4),
      body: {
        kind: 'message',
        role: 'user',
        blocks: [{ type: 'text', text: '/context' }],
        command: { name: 'context' }
      }
    }
    const commandTurn: AgentJournalRenderItem = {
      itemId: agentJournalItemKey({ provider: 'codex', threadId: 't', turnId: 'cmd', ordinal: 1 }),
      revision: 1,
      sequence: 5,
      observedAt: 7,
      body: {
        kind: 'turn',
        turnId: 'cmd',
        state: 'completed',
        outcome: 'success',
        userItemId: command.itemId
      }
    }
    expect(
      latestNativeChatOrcaStopCut(
        [userMessage(1), cutTurn(), stopRow(update), command, commandTurn],
        []
      )
    ).toEqual({ turnItemId: turnId, cause: 'update' })
  })

  it('is gone while a send is on its way', () => {
    expect(
      latestNativeChatOrcaStopCut(
        [userMessage(1), cutTurn(), stopRow(update)],
        [{ dispatchState: 'pending' }]
      )
    ).toBeNull()
  })

  it("is none for a stop with no Orca cause, a person's Stop, or an unscoped row", () => {
    expect(latestNativeChatOrcaStopCut([cutTurn(), stopRow(undefined)], [])).toBeNull()
    expect(latestNativeChatOrcaStopCut([cutTurn('cancellation'), stopRow(update)], [])).toBeNull()
    expect(latestNativeChatOrcaStopCut([cutTurn(), stopRow(update, false)], [])).toBeNull()
  })
})
