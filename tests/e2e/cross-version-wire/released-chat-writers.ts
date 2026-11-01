import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import {
  AGENT_JOURNAL_THREAD_SCOPE,
  type AgentJournalMessageItem,
  type AgentJournalSnapshot,
  type AgentSessionJournalIdentity
} from '../../../src/shared/agent-session-journal-types'
import {
  claudeProviderHandle,
  codexProviderHandle
} from '../../../src/shared/agent-session-provider-handle-encoding'
import type { agentSessionFailureFact } from '../../../src/shared/agent-session-failure'
import type { agentSessionFailureWords } from '../../../src/shared/agent-session-failure-words'
import type { createClaudeJournalTranslator } from '../../../src/main/claude/claude-structured-journal-translation'
import type { createCodexJournalTranslator } from '../../../src/main/codex/codex-structured-journal-translation'
import type { createDeferredStructuredAgentSessionEventSink } from '../../../src/main/native-chat/agent-session-wire/structured-agent-session-event-sink'
import type { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  releaseModuleExport
} from './release-checkout'
import { queueReleasedCards } from './released-chat-queue'

// A released build's own writers, for a chat as its host writes one: its translators fed its own
// captured provider streams, sends with their dispatch results, queue edits, Stop and Resume, a
// Stop settlement and a removed item.

const JOURNAL = 'src/main/native-chat/agent-session-journal'
const FENCE = 1

export type Agent = 'claude' | 'codex'
type Opener = ReturnType<typeof createTrackedJournalOpener>
type Journal = Awaited<ReturnType<Opener['open']>>
type Released = Awaited<ReturnType<typeof released>>

export const identityOf = (agent: Agent): AgentSessionJournalIdentity => ({
  sessionId: `session-released-${agent}`,
  workspaceId: 'ws-1',
  hostId: 'host-1',
  agent,
  providerHandle:
    agent === 'codex' ? codexProviderHandle('thread-1') : claudeProviderHandle('claude-1', null)
})

async function released(ref: string) {
  const checkout = await materializeReleaseCheckout(ref)
  const load = async <T>(path: string, name: string): Promise<T> =>
    releaseModuleExport<T>(await importReleaseCheckoutModule(checkout, path), name)
  const fact = await load<typeof agentSessionFailureFact>(
    'src/shared/agent-session-failure.ts',
    'agentSessionFailureFact'
  )
  const words = await load<typeof agentSessionFailureWords>(
    'src/shared/agent-session-failure-words.ts',
    'agentSessionFailureWords'
  )
  return {
    root: checkout.root,
    opener: await load<typeof createTrackedJournalOpener>(
      `${JOURNAL}/journal-host-database-test-support.ts`,
      'createTrackedJournalOpener'
    ),
    claude: await load<typeof createClaudeJournalTranslator>(
      'src/main/claude/claude-structured-journal-translation.ts',
      'createClaudeJournalTranslator'
    ),
    codex: await load<typeof createCodexJournalTranslator>(
      'src/main/codex/codex-structured-journal-translation.ts',
      'createCodexJournalTranslator'
    ),
    sink: await load<typeof createDeferredStructuredAgentSessionEventSink>(
      'src/main/native-chat/agent-session-wire/structured-agent-session-event-sink.ts',
      'createDeferredStructuredAgentSessionEventSink'
    ),
    queueFull: () => words(fact('queueFull'), { surface: 'rejection' }),
    /** Releases before Stop events record only the interrupted turn. */
    stopEvents: existsSync(join(checkout.root, JOURNAL, 'journal-stop-marks.ts'))
  }
}

const message = (text: string): AgentJournalMessageItem => ({
  kind: 'message',
  role: 'user',
  blocks: [{ type: 'text', text }]
})

/** Sends, their dispatch results and queue edits, as the host's send and queue paths write them. */
async function sendsAndQueue(journal: Journal, release: Released): Promise<void> {
  await journal.appendSubmission({
    clientMessageId: 'sent',
    payloadFingerprint: 'fp-sent',
    body: message('sent'),
    fence: FENCE,
    handoverRecorded: true,
    origin: 'client',
    source: { kind: 'user' },
    options: { model: 'model-1', effort: 'high' }
  })
  await journal.resolveDispatch({
    clientMessageId: 'sent',
    fence: FENCE,
    state: 'pending',
    turnScope: AGENT_JOURNAL_THREAD_SCOPE
  })
  await journal.resolveDispatch({
    clientMessageId: 'sent',
    fence: FENCE,
    state: 'accepted',
    providerIdentity: null
  })
  await journal.appendSubmission({
    clientMessageId: 'refused',
    payloadFingerprint: 'fp-refused',
    body: message('refused'),
    fence: FENCE
  })
  await journal.resolveDispatch({
    clientMessageId: 'refused',
    fence: FENCE,
    state: 'rejected',
    ...release.queueFull()
  })
  await queueReleasedCards(journal.queuedMessages)
}

const claudeCapture = z.object({ at: z.number(), frame: z.record(z.string(), z.unknown()) })
const codexCapture = z.object({
  case: z.string(),
  t: z.number(),
  method: z.string(),
  params: z.record(z.string(), z.unknown())
})

function capture(release: Released, path: string): unknown[] {
  return readFileSync(join(release.root, path), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
}

/** The release's translator, fed its own captured provider stream, writes through its event sink. */
async function stream(
  release: Released,
  agent: Agent,
  journal: Journal,
  clock: { at: number }
): Promise<void> {
  const sessionId = identityOf(agent).sessionId
  const failed = vi.fn()
  const sink = release.sink({
    sessionId,
    logger: { warn: vi.fn(), error: vi.fn() },
    onFailed: failed
  })
  sink.bind({ journal, fence: FENCE, publish: () => undefined })
  const pending = new Set<() => void>()
  const schedule = (run: () => void) => {
    pending.add(run)
    return () => {
      pending.delete(run)
    }
  }
  const flush = async (translator: { flush: () => void }) => {
    translator.flush()
    const runs = [...pending]
    pending.clear()
    for (const run of runs) {
      run()
    }
    expect(await sink.drained()).toEqual({ ok: true })
  }
  try {
    if (agent === 'claude') {
      const translator = release.claude({ sink: sink.sink, schedule })
      for (const line of capture(
        release,
        'src/main/claude/__fixtures__/claude-adapter-capture-miss.jsonl'
      )) {
        const record = claudeCapture.safeParse(line)
        if (record.success) {
          clock.at = 1_000 + record.data.at
          translator.handle({
            type: 'message',
            sessionId,
            message: record.data.frame,
            observedAt: clock.at
          })
          await flush(translator)
        }
      }
      translator.dispose()
    } else {
      const translator = release.codex({ sink: sink.sink, schedule, now: () => clock.at })
      const records = capture(
        release,
        'src/main/codex/__fixtures__/codex-app-server-turn-endings.jsonl'
      )
        .map((line) => codexCapture.parse(line))
        .filter((record) => record.case === '0.158.0-control')
      expect(records.length).toBeGreaterThan(0)
      for (const record of records) {
        clock.at = 1_000 + record.t
        const threadId =
          typeof record.params.threadId === 'string' ? record.params.threadId : 'thread-1'
        translator.handle({
          type: 'notification',
          sessionId,
          threadId,
          method: record.method,
          params: record.params,
          observedAt: clock.at
        })
        await flush(translator)
      }
      translator.dispose()
    }
    expect(failed).not.toHaveBeenCalled()
  } finally {
    sink.close()
  }
}

/** A Stop with its settlement, a Resume, and an item later removed. */
async function stopAndRemove(
  journal: Journal,
  release: Released,
  clock: { at: number }
): Promise<void> {
  const stopped = { provider: 'orca', clientMessageId: 'stopped-turn' } as const
  const scope = { fence: FENCE, turnScope: AGENT_JOURNAL_THREAD_SCOPE }
  await journal.appendItem(stopped, { kind: 'turn', turnId: 'stop-turn', state: 'running' }, scope)
  if (release.stopEvents) {
    await journal.appendStopEvent({ reason: 'user-stop', turnId: 'stop-turn' }, FENCE)
  }
  const settle = release.stopEvents ? journal.stopMarks.beginSettle(true) : undefined
  await journal.appendLifecycleBatch({
    settlementId: 'stop-settlement',
    fence: FENCE,
    mutations: [
      {
        kind: 'item',
        identity: stopped,
        body: {
          kind: 'turn',
          turnId: 'stop-turn',
          state: 'interrupted',
          completedAt: clock.at + 1
        },
        turnScope: AGENT_JOURNAL_THREAD_SCOPE
      }
    ]
  })
  if (settle !== undefined) {
    journal.stopMarks.settled(settle)
    await journal.appendQueueResume(FENCE)
  }
  const removed = { provider: 'orca', clientMessageId: 'removed-note' } as const
  await journal.appendItem(removed, { kind: 'status', text: 'removed' }, scope)
  await journal.appendTombstone(removed, { fence: FENCE })
}

/** Writes a whole chat with the release at `ref`; returns the chat and queue as it closed them. */
export async function writeReleasedChat(
  ref: string,
  agent: Agent,
  stateDirectory: string
): Promise<{ snapshot: AgentJournalSnapshot; cards: unknown[]; now: () => number }> {
  const release = await released(ref)
  const clock = { at: 1_000 }
  const journals = release.opener()
  try {
    const journal = await journals.open({
      identity: identityOf(agent),
      stateDirectory,
      now: () => clock.at
    })
    if (agent === 'codex') {
      // An imported conversation's epoch carries its history origin.
      await journal.replaceEpochItems('legacy_import', FENCE, [])
    }
    await sendsAndQueue(journal, release)
    await stream(release, agent, journal, clock)
    await stopAndRemove(journal, release, clock)
    return {
      snapshot: journal.snapshot(),
      cards: [...journal.queuedMessages.list()],
      now: () => clock.at
    }
  } finally {
    await journals.closeAll()
  }
}

/** The release's own journal opener, to carry a chat on as that release would. */
export async function releasedJournalOpener(ref: string): Promise<Opener> {
  return (await released(ref)).opener()
}
