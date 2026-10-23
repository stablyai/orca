import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import {
  endedRunningAgentJournalToolCall,
  interruptedAgentJournalToolCall
} from '../../../src/shared/agent-journal-tool-call-lifecycle'
import type { AgentJournalItemIdentity } from '../../../src/shared/agent-session-journal-types'
import { createTrackedJournalOpener } from '../../../src/main/native-chat/agent-session-journal/journal-host-database-test-support'
import type { JournalRow } from '../../../src/main/native-chat/agent-session-journal/journal-row-schema'
import { importReleaseCheckoutModule, materializeReleaseCheckout } from './release-checkout'

// A release that predates a tool call's `endedAs`. Pinned, not the newest tag: what it must do is
// read the cut-short call as failed, which no later release will contradict.
const BASELINE_REF = 'v1.4.218'

const SESSION = 'session-interrupted-tool'

function call(ordinal: number): AgentJournalItemIdentity {
  return { provider: 'codex', threadId: 'thread-1', turnId: 'turn-1', ordinal }
}

function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (value === undefined) {
    throw new Error(`the pinned release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: an export the pinned release has; each caller names the shape it uses, and a changed one fails the test.
  return value as T
}

type OldRenderItem = { itemId: string; body: { kind: string; [field: string]: unknown } }
type OldMessage = { blocks: unknown[] } | null
type OldRunOutcome = (
  blocks: readonly unknown[],
  options: { activeTurnIsWorking?: boolean }
) => { failedCallCount: number; succeeded: boolean }

// Loads a real old build, including cold extraction and transforms.
test('an older host and client read a call a stop cut short as the failure they always showed', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'orca-interrupted-tool-downgrade-'))
  const journals = createTrackedJournalOpener()
  try {
    // This build: a call a stop cut short, with the partial output it left.
    const journal = await journals.open({
      identity: {
        sessionId: SESSION,
        workspaceId: 'ws-1',
        hostId: 'host-1',
        agent: 'codex',
        providerHandle: { kind: 'codex', threadId: 'thread-1' }
      },
      stateDirectory: directory,
      now: () => 1_000
    })
    const cutShort = interruptedAgentJournalToolCall({
      kind: 'tool-call',
      name: 'shell',
      input: { command: 'sleep 20' },
      state: 'running',
      output: { head: 'partial', byteLength: 7, digest: 'd', truncated: false }
    })
    await journal.appendItem(call(0), cutShort, { fence: 1, turnScope: { kind: 'thread' } })
    // And one an end nothing proved closed, kept so a later proof can still correct it.
    const unverified = endedRunningAgentJournalToolCall(
      { kind: 'tool-call', name: 'shell', input: { command: 'sleep 30' }, state: 'running' },
      'unverifiable'
    )
    await journal.appendItem(call(1), unverified, { fence: 1, turnScope: { kind: 'thread' } })
    const since = journal.readSince({ epoch: journal.epoch, sequence: 0 })
    if (!since.ok) {
      throw new Error(`expected rows, got reset ${since.reset}`)
    }
    const rows: JournalRow[] = since.rows
    const current = journal.snapshot().items
    expect(current.map((item) => item.body)).toMatchObject([
      { state: 'failed', endedAs: 'interrupted' },
      { state: 'failed', endedAs: 'unverifiable' }
    ])

    const checkout = await materializeReleaseCheckout(BASELINE_REF)
    const [reducer, schemas, projection, outcome] = await Promise.all(
      [
        'src/main/native-chat/agent-session-journal/journal-reducer.ts',
        'src/shared/agent-session-journal-schemas.ts',
        'src/shared/structured-agent-session-projection.ts',
        'src/shared/native-chat-tool-run-outcome.ts'
      ].map((path) => importReleaseCheckoutModule(checkout, path))
    )
    const createState = releaseExport<(sessionId: string, epoch: string) => unknown>(
      reducer,
      'createJournalReducerState'
    )
    const applyRow = releaseExport<(state: unknown, row: JournalRow) => void>(
      reducer,
      'applyJournalRow'
    )
    const render = releaseExport<(state: unknown) => { items: OldRenderItem[] }>(
      reducer,
      'renderJournalState'
    )
    const renderItemSchema = releaseExport<{ parse: (value: unknown) => OldRenderItem }>(
      schemas,
      'AgentJournalRenderItemSchema'
    )
    const project = releaseExport<(item: unknown) => OldMessage>(
      projection,
      'projectStructuredItemToNativeChat'
    )
    const runOutcome = releaseExport<OldRunOutcome>(outcome, 'nativeChatToolRunOutcome')
    const settled = { activeTurnIsWorking: false }

    const blocksOf = (items: OldRenderItem[]) =>
      items.flatMap((item) => project(item)?.blocks ?? [])

    // The older host, after a downgrade, folds the rows it never wrote as failed calls.
    const state = createState(SESSION, journal.epoch)
    for (const row of rows) {
      applyRow(state, row)
    }
    const folded = render(state).items
    expect(folded.map((item) => item.body)).toMatchObject([
      { kind: 'tool-call', state: 'failed' },
      { kind: 'tool-call', state: 'failed' }
    ])
    expect(runOutcome(blocksOf(folded), settled)).toEqual({
      failedCallCount: 2,
      succeeded: false
    })

    // The older client reads this host's render items the same way.
    const read = current.map((item) => renderItemSchema.parse(item))
    expect(runOutcome(blocksOf(read), settled)).toEqual({
      failedCallCount: 2,
      succeeded: false
    })

    // Why the fact rides beside `failed` rather than replacing it: that build calls an unknown
    // state a success.
    const asNewState = renderItemSchema.parse({
      ...current[0],
      body: { ...cutShort, state: 'interrupted', endedAs: undefined }
    })
    expect(runOutcome(project(asNewState)?.blocks ?? [], settled).succeeded).toBe(true)
  } finally {
    await journals.closeAll()
    rmSync(directory, { recursive: true, force: true })
  }
})
