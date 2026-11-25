// Bench, not a CI test: `node tests/tools/benchmarks/bot-chat-tree/bot-chat-tree-bench.mjs`.
// Main-thread ms that one botsChanged costs the host: every chat tree it makes a client re-read.
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { afterAll, it } from 'vitest'
import type { Bot } from '../../../../src/shared/bot-types'
import { folderWorkspaceKey } from '../../../../src/shared/workspace/identity/workspace-scope'
import {
  scaleDirectory,
  scaleRecord
} from '../../../../src/main/runtime/agent-session/records/agent-session-scale.test-fixture'
import { openTestAgentSessionRecordStore } from '../../../../src/main/runtime/agent-session/records/agent-session-record-store-test-harness'
import { seedTestAgentSessionRecordStore } from '../../../../src/main/runtime/agent-session/records/agent-session-record-store-persistence.test-fixture'
import { conversationRecordReader } from '../../../../src/main/runtime/orchestration/addressing/session-lineage/structured-session-lineage'
import { OrchestrationDb } from '../../../../src/main/runtime/orchestration/db/orchestration-db'
import Database from '../../../../src/main/sqlite/sync-database'
import { readBotChatTree, type BotChatTreeHost } from '../../../../src/main/bots/bot-chat-tree-host'
import { readBotChatInputs } from '../../../../src/main/bots/bot-chat-tree-base'
import { createBotChatTreeIndex } from '../../../../src/main/bots/bot-chat-tree-index'
import type { BotChangeScope } from '../../../../src/shared/bots/bot-change-scope'
import { BotLookAroundStore } from '../../../../src/main/bots/bot-look-around-store'
import { makeTestBot } from '../../../../src/main/bots/bot.test-fixture'

const BOTS = Number(process.env.BENCH_BOTS ?? 20)
const CHATS = Number(process.env.BENCH_CHATS ?? 500)
const DISPATCHES_PER_CHAT = Number(process.env.BENCH_DISPATCHES ?? 3)
const OTHER_RECORDS = 5_000
const OUT = process.env.BENCH_OUT

// `before`: no index, and every notice re-reads every bot, as before per-bot notices.
const WITH_INDEX = process.env.BENCH_MODE !== 'before'

const chatId = (bot: number, chat: number) => `chat-${bot}-${String(chat).padStart(5, '0')}`
const homeOf = (bot: number) => `home-${bot}`

const opened: OrchestrationDb[] = []
afterAll(() => opened.splice(0).forEach((db) => db.close()))

type Notice = BotChangeScope

it(`one botsChanged at ${BOTS} bots x ${CHATS} chats`, { timeout: 1_800_000 }, async () => {
  const bots: Bot[] = Array.from({ length: BOTS }, (_, i) =>
    makeTestBot({ id: `bot-${i}`, folderWorkspaceId: homeOf(i), chatSessionId: chatId(i, 0) })
  )
  const root = await scaleDirectory()
  const seedStarted = performance.now()
  await seedTestAgentSessionRecordStore(root, {
    records: [
      ...bots.flatMap((bot, b) =>
        Array.from({ length: CHATS }, (_, c) => ({
          ...scaleRecord(chatId(b, c), folderWorkspaceKey(bot.folderWorkspaceId)),
          conversationName: `Chat ${c} of ${bot.id}`,
          lastTurn: { state: 'settled' as const, at: c, reply: 'Two PRs merged, one in review.' }
        }))
      ),
      ...Array.from({ length: OTHER_RECORDS }, (_, i) =>
        scaleRecord(`other-${String(i).padStart(5, '0')}`, 'workspace-elsewhere')
      )
    ]
  })
  const store = await openTestAgentSessionRecordStore(root)
  const records = conversationRecordReader(store)

  const path = join(root, 'orchestration.db')
  const raw = new Database(path)
  const db = new OrchestrationDb(path)
  opened.push(db)
  const task = raw.prepare(
    "INSERT INTO tasks (id, spec, task_title, status) VALUES (?, 'spec', ?, 'completed')"
  )
  const dispatch = raw.prepare(
    "INSERT INTO dispatch_contexts (id, task_id, creator_orca_session_id, status) VALUES (?, ?, ?, 'completed')"
  )
  raw.exec('BEGIN')
  for (let b = 0; b < BOTS; b += 1) {
    for (let c = 0; c < CHATS; c += 1) {
      for (let d = 0; d < DISPATCHES_PER_CHAT; d += 1) {
        const id = `${b}-${c}-${d}`
        task.run(`task-${id}`, `PR ${d}: relay auth`)
        dispatch.run(`ctx-${id}`, `task-${id}`, chatId(b, c))
      }
    }
  }
  raw.exec('COMMIT')
  raw.close()
  const seedMs = performance.now() - seedStarted

  const notices: Notice[] = []
  const base: BotChatTreeHost = {
    bots: () => bots,
    externalConversations: () => [],
    chatTabs: async () => [],
    statusRows: () => [],
    automations: () => [],
    automationRuns: () => new Map(),
    recordedWorkers: async () => [],
    sessionRecords: async () => records,
    db: () => db,
    dispatchWorkers: async () => [],
    backgroundRuns: new BotLookAroundStore({ read: () => null, write: async () => {} }, () => {})
  }
  const index = WITH_INDEX
    ? createBotChatTreeIndex({
        bots: base.bots,
        records: () => records,
        db: () => db,
        backgroundRuns: base.backgroundRuns,
        inputs: (bot) => readBotChatInputs(base, bot),
        changed: (scope) => notices.push(scope)
      })
    : null
  if (index) {
    db.workerStatusListener = (id, change) => index.dispatchLinkChanged(id, change)
  }
  const host: BotChatTreeHost = index ? { ...base, index } : base

  // Every unfolded bot's sidebar reads its tree once before any notice.
  for (const bot of bots) {
    await readBotChatTree(host, { botId: bot.id })
  }

  // Every orchestration.db statement the host runs (one prepare per execution), counted per notice.
  let dbStatements = 0
  const prepare = db.db.prepare.bind(db.db)
  db.db.prepare = (sql: string) => {
    dbStatements += 1
    return prepare(sql)
  }

  /** The bots one notice makes a client re-read: those it names, or all of them. */
  const reread = async (): Promise<{ ms: number; reads: number; dbStatements: number }> => {
    await new Promise((resolve) => setImmediate(resolve))
    const named = new Set<string>()
    let all: boolean = !index
    for (const notice of notices.splice(0)) {
      if (!notice.botIds) {
        all = true
      }
      notice.botIds?.forEach((id) => named.add(id))
    }
    const targets = all ? bots : bots.filter((bot) => named.has(bot.id))
    const statementsBefore = dbStatements
    const started = performance.now()
    for (const bot of targets) {
      await readBotChatTree(host, { botId: bot.id })
    }
    return {
      ms: performance.now() - started,
      reads: targets.length,
      dbStatements: dbStatements - statementsBefore
    }
  }

  let step = 0
  const events: Record<string, () => Promise<void>> = {
    // A bot chat's turn ends: its record's last turn moves.
    'bot chat turn': async () => {
      step += 1
      await store.setConversationName(chatId(0, 1), `Renamed ${step}`)
    },
    'worker settles': async () => {
      step += 1
      db.db
        .prepare("UPDATE dispatch_contexts SET status = ? WHERE id = 'ctx-0-2-0'")
        .run(step % 2 ? 'failed' : 'completed')
    },
    'chat of another bot': async () => {
      step += 1
      await store.setConversationName(chatId(1, 3), `Side chat ${step}`)
    },
    'chat outside any bot': async () => {
      step += 1
      await store.setConversationName('other-00001', `Elsewhere ${step}`)
    }
  }
  const results: Record<string, { ms: number; reads: number; dbStatements: number }> = {}
  for (const [name, apply] of Object.entries(events)) {
    const runs: { ms: number; reads: number; dbStatements: number }[] = []
    const reps = BOTS * CHATS > 20_000 ? 2 : 5
    for (let rep = 0; rep < reps; rep += 1) {
      notices.splice(0)
      // From before the write: a Dispatch change's own by-id read counts (and so does its UPDATE).
      const statementsAtWrite = dbStatements
      await apply()
      const run = await reread()
      runs.push({ ...run, dbStatements: dbStatements - statementsAtWrite })
    }
    const sorted = runs.toSorted((a, b) => a.ms - b.ms)
    results[name] = sorted[Math.floor(sorted.length / 2)]!
  }
  // The full check against every record, as an idle host runs it per bot at most every 15 min.
  const fullCheck = index ? index.verify(bots[0]!.id) : null
  const report = {
    build: index ? 'after' : 'before',
    bots: BOTS,
    chatsPerBot: CHATS,
    dispatchesPerChat: DISPATCHES_PER_CHAT,
    otherRecords: OTHER_RECORDS,
    seedMs: Math.round(seedMs),
    ...(index
      ? {
          selfCheck: {
            driftFound: index.drift.count,
            cheapCheckMsTotal: Number(index.drift.cheapCheckMs.toFixed(1)),
            fullCheckMsOneBot: Number((fullCheck?.ms ?? 0).toFixed(1)),
            fullCheckDrift: fullCheck?.drift ?? null
          }
        }
      : {}),
    perNotice: Object.fromEntries(
      Object.entries(results).map(([name, r]) => [
        name,
        { mainMs: Number(r.ms.toFixed(1)), chatTreeReads: r.reads, dbStatements: r.dbStatements }
      ])
    )
  }
  console.info(JSON.stringify(report))
  if (OUT) {
    writeFileSync(OUT, `${JSON.stringify(report, null, 2)}\n`)
  }
})
