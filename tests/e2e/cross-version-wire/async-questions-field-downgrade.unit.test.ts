// The host now publishes an optional `asyncQuestions` side field on structured subscribe frames
// and keeps `asyncQuestions` metadata on a journal text block. A client from the latest release
// knows neither: it must reduce those frames exactly as before and admit the row with the key.

import { expect, test } from 'vitest'
import {
  importReleaseCheckoutModule,
  materializeReleaseCheckout,
  resolveBaselineReleaseRef
} from './release-checkout'

const ASYNC_QUESTIONS = {
  state: 'ready',
  questions: [{ key: '["request_user_input_async","i",0]', index: 0, title: 'Color?' }]
}
const ITEM = {
  itemId: 'item-1',
  revision: 1,
  sequence: 1,
  observedAt: 1,
  body: {
    kind: 'message',
    role: 'assistant',
    blocks: [
      {
        type: 'text',
        text: 'Color?',
        asyncQuestions: { providerItemId: 'call-1', questions: [{ title: 'Color?' }] }
      }
    ]
  }
}
const SNAPSHOT = {
  type: 'snapshot',
  sessionId: 's',
  fence: 1,
  asyncQuestions: ASYNC_QUESTIONS,
  page: {
    sessionId: 's',
    epoch: 'e',
    direction: 'tail',
    items: [ITEM],
    removedItemIds: [],
    submissions: [],
    window: {
      oldest: { epoch: 'e', sequence: 1 },
      newest: { epoch: 'e', sequence: 1 },
      nextCursor: { epoch: 'e', sequence: 2 }
    },
    liveCursor: { epoch: 'e', sequence: 1 },
    hasOlder: false,
    hasNewer: false
  }
}
const BATCH = {
  type: 'batch',
  sessionId: 's',
  asyncQuestions: { state: 'ready', questions: [] },
  batch: { cursor: { epoch: 'e', sequence: 2 }, items: [], removedItemIds: [], submissions: [] }
}

/** A function the release exports, typed as the caller calls it. */
function releaseExport<T>(module: Record<string, unknown>, name: string): T {
  const value = module[name]
  if (typeof value !== 'function') {
    throw new Error(`the release exports no ${name}`)
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: a function the release exports; each caller names the signature it calls, and a changed one fails the test.
  return value as T
}

type ReleaseState = { items: { itemId: string; body: unknown }[]; cursor: unknown; status: string }

// Loads a real released build, including a cold extraction.
test('the latest release reduces frames that carry the async question field as before', async () => {
  const checkout = await materializeReleaseCheckout(resolveBaselineReleaseRef())
  const [reducerModule, schemas] = await Promise.all(
    [
      'src/shared/structured-agent-session-reducer.ts',
      'src/shared/agent-session-journal-schemas.ts'
    ].map((path) => importReleaseCheckoutModule(checkout, path))
  )
  const reduce = releaseExport<(state: unknown, action: unknown) => ReleaseState>(
    reducerModule,
    'reduceStructuredAgentSession'
  )
  const empty = reducerModule.EMPTY_STRUCTURED_AGENT_SESSION
  const admits = releaseExport<(value: unknown) => boolean>(
    schemas,
    'isAdmissibleAgentJournalRenderItem'
  )

  expect(admits(ITEM)).toBe(true)
  const hydrated = reduce(empty, { type: 'event', event: SNAPSHOT })
  expect(hydrated.status).toBe('ready')
  expect(hydrated.items.map((item) => item.itemId)).toEqual(['item-1'])
  expect(JSON.stringify(hydrated.items[0]?.body)).toContain('"asyncQuestions"')
  const advanced = reduce(hydrated, { type: 'event', event: BATCH })
  expect(advanced.cursor).toEqual({ epoch: 'e', sequence: 2 })
  expect(advanced.items.map((item) => item.itemId)).toEqual(['item-1'])

  // An over-budget set is published partially with `omittedCount`; the release ignores both.
  const { asyncQuestions: _field, ...withoutField } = SNAPSHOT
  const overBudget = { ...SNAPSHOT, asyncQuestions: { ...ASYNC_QUESTIONS, omittedCount: 400 } }
  expect(reduce(empty, { type: 'event', event: overBudget })).toEqual(
    reduce(empty, { type: 'event', event: withoutField })
  )
}, 180_000)
