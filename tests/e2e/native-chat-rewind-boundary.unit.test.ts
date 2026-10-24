// @vitest-environment happy-dom
import { renderHook } from '@testing-library/react'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import {
  agentJournalItemKey,
  agentJournalSubmissionKey
} from '../../src/shared/agent-session-journal-item-key'
import { EMPTY_STRUCTURED_AGENT_SESSION } from '../../src/shared/structured-agent-session-reducer'
import { AGENT_JOURNAL_THREAD_SCOPE } from '../../src/shared/agent-session-journal-types'
import { codexProviderHandle } from '../../src/shared/agent-session-provider-handle-encoding'
import { createTrackedJournalOpener } from '../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import { structuredRewindCut } from '../../src/main/native-chat/agent-session-wire/structured-rewind-cut'
import { useNativeChatRewind } from '../../src/renderer/src/components/native-chat/use-native-chat-rewind'

const IDENTITY = {
  sessionId: 'session-1',
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent: 'codex',
  providerHandle: codexProviderHandle('main')
}
const journals = createTrackedJournalOpener()
let root: string
afterEach(async () => {
  await journals.closeAll()
  await rm(root, { recursive: true, force: true })
})

it('offers a recovered opener only when its saved native alias arrives, retaining prior history', async () => {
  root = await mkdtemp(join(tmpdir(), 'orca-rewind-boundary-'))
  const options = { identity: IDENTITY, stateDirectory: root }
  const journal = await journals.open(options)
  const native = (uuid: string) => ({ provider: 'claude' as const, sessionId: 'original', uuid })
  const blocks = [{ type: 'text' as const, text: 'prompt' }]
  const body = { kind: 'message' as const, role: 'user' as const, blocks }
  const attribution = { fence: 1, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(native('earlier'), body, attribution)
  await journal.appendItem(native('reply'), { ...body, role: 'assistant' }, attribution)
  await journal.appendSubmission({
    clientMessageId: 'lost',
    payloadFingerprint: 'lost',
    body,
    fence: 1
  })
  await journals.closeAll()
  const recovered = await journals.open(options)
  await recovered.markPendingSubmissionsUnknown(2)
  const snapshot = recovered.snapshot()
  const target = agentJournalSubmissionKey('lost')
  expect(snapshot.submissions.find((row) => row.clientMessageId === 'lost')).toMatchObject({
    dispatchState: 'unknown',
    recovered: true
  })
  const state = {
    ...EMPTY_STRUCTURED_AGENT_SESSION,
    ...snapshot,
    epoch: snapshot.cursor.epoch,
    status: 'ready' as const,
    fence: 2
  }
  const props = {
    sessionId: IDENTITY.sessionId,
    capturePresentation: () => () => true,
    state,
    support: { supported: true as const },
    blocked: false,
    send: vi.fn()
  }
  const view = renderHook((input) => useNativeChatRewind(input), { initialProps: props })
  try {
    expect(view.result.current.surface?.eligibleItemIds).not.toContain(target)
    const cursor = recovered.cursor()
    expect(
      structuredRewindCut(recovered, { itemId: target, provider: 'claude', nativeId: 'forked' })
    ).toBeNull()
    expect(recovered.cursor()).toEqual(cursor)
    view.rerender({ ...props, state: { ...state, submissions: [] } })
    expect(view.result.current.surface?.eligibleItemIds).toContain(target)
    await recovered.acceptLate({
      clientMessageId: 'lost',
      state: 'accepted',
      providerIdentity: native('genuine'),
      fence: 2
    })
    view.rerender({ ...props, state: { ...state, submissions: recovered.snapshot().submissions } })
    expect(view.result.current.surface?.eligibleItemIds).toContain(target)
    const cut = structuredRewindCut(recovered, {
      itemId: target,
      provider: 'claude',
      nativeId: 'forked'
    })
    expect(cut).toMatchObject({ beforeMessage: { sessionId: 'original', uuid: 'genuine' } })
    expect(cut?.kept.map(({ identity }) => agentJournalItemKey(identity))).toEqual([
      agentJournalItemKey(native('earlier')),
      agentJournalItemKey(native('reply'))
    ])
  } finally {
    view.unmount()
  }
})
