import { describe, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import { agentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureWords } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
import {
  nativeChatAgySignedOutBeforeSend,
  nativeChatSignInAccount
} from './native-chat-sign-in-account'

let sequence = 0
function row(itemId: string, body: AgentJournalRenderItem['body']): AgentJournalRenderItem {
  sequence += 1
  return { itemId, revision: 1, sequence, observedAt: sequence, body }
}
const failed = (
  id: string,
  kind: 'notSignedIn' | 'claudeAccountFolderMissing',
  account?: AgentSessionAccountKind
) =>
  row(id, {
    kind: 'status',
    tone: 'error',
    ...agentSessionFailureWords(agentSessionFailureFact(kind, account ? { account } : {}), {
      agentName: 'Claude',
      surface: 'row'
    })
  })
const succeeded = (id: string) =>
  row(id, { kind: 'turn', turnId: id, state: 'completed', outcome: 'success' })
const send = (dispatchState: 'accepted' | 'rejected', account?: AgentSessionAccountKind) => {
  sequence += 1
  const rejection = { kind: 'notSignedIn', ...(account ? { account } : {}) } as const
  return {
    dispatchState,
    submittedSequence: sequence,
    ...(dispatchState === 'rejected' ? { rejection } : {})
  }
}

const account = (items: AgentJournalRenderItem[], submissions: ReturnType<typeof send>[] = []) =>
  nativeChatSignInAccount({ unavailable: null, launchDetails: undefined, items, submissions })

describe('the account a chat signs in with', () => {
  it('is none for an old signed-out line a newer failure replaced (Claude, managed folder missing)', () => {
    const items = [
      failed('old', 'notSignedIn', 'system'),
      succeeded('t1'),
      failed('new', 'claudeAccountFolderMissing')
    ]
    expect(account(items)).toBeUndefined()
  })

  it('is the newer refused send’s, not an older line’s (Codex switched to system)', () => {
    const items = [failed('old', 'notSignedIn', 'managed')]
    expect(account(items, [send('rejected', 'system')])).toBe('system')
  })

  it('is none once a later send went through or a turn succeeded', () => {
    expect(account([], [send('rejected', 'system'), send('accepted')])).toBeUndefined()
    // A send refused after the latest success still stands.
    const success = succeeded('t2')
    expect(account([success], [send('rejected', 'system')])).toBe('system')
    expect(account([failed('line', 'notSignedIn', 'system'), succeeded('t3')])).toBeUndefined()
  })
})

describe("agy's sign-in before the first send", () => {
  it('is said while nothing was sent and the host knows agy is signed out', () => {
    expect(nativeChatAgySignedOutBeforeSend(true, [])).toEqual({
      reason: 'notSignedIn',
      account: 'system'
    })
  })

  it.each([
    ['once a message was sent', true, [{}]],
    ['when the host does not know', undefined, []],
    ['when agy is signed in', false, []]
  ])('is not said %s', (_case, signedOut, submissions) => {
    expect(nativeChatAgySignedOutBeforeSend(signedOut, submissions)).toBeNull()
  })
})
