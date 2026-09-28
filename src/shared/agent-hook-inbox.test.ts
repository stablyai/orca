import { afterEach, describe, expect, it } from 'vitest'
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  AGENT_HOOK_INBOX_MAX_RECORD_AGE_MS,
  AGENT_HOOK_INBOX_TORN_RECORD_MAX_AGE_MS,
  AgentHookInbox,
  openAgentHookInbox
} from './agent-hook-inbox'
import { parseAgentHookInboxRecord, type AgentHookInboxRecord } from './agent-hook-inbox-record'

const PANE = 'tab-1:11111111-1111-4111-8111-111111111111'

function record(payload: string, trailer: Record<string, string> = {}, eol = '\n'): string {
  const fields = { source: 'codex', paneKey: PANE, ...trailer }
  return [
    payload,
    'orca-hook-record v1',
    ...Object.entries(fields).map(([key, value]) => `${key}=${value}`),
    'orca-hook-end',
    ''
  ].join(eol)
}

const opened: AgentHookInbox[] = []
function openInbox(dir: string, now?: () => number) {
  const ingested: { record: AgentHookInboxRecord; isReplay: boolean }[] = []
  const inbox = new AgentHookInbox(
    dir,
    (entry, { isReplay }) => ingested.push({ record: entry, isReplay }),
    now
  )
  opened.push(inbox)
  return { inbox, ingested, opened: inbox.open() }
}

afterEach(() => {
  for (const inbox of opened.splice(0)) {
    inbox.close()
  }
})

function tempInbox(): string {
  return join(mkdtempSync(join(tmpdir(), 'orca-hook-inbox-')), 'hook-inbox')
}

describe('parseAgentHookInboxRecord', () => {
  it('restores the POST body, payload bytes unchanged', () => {
    const payload = '{"hook_event_name":"Stop","t":"日本 100% \\\\n"}'
    expect(
      parseAgentHookInboxRecord(Buffer.from(record(payload, { tabId: 'tab-1', grokHome: '/g' })))
    ).toEqual({
      kind: 'complete',
      record: { source: 'codex', body: { paneKey: PANE, tabId: 'tab-1', grokHome: '/g', payload } }
    })
  })

  it('reads a CRLF trailer', () => {
    const parsed = parseAgentHookInboxRecord(Buffer.from(record('{}', {}, '\r\n')))
    expect(parsed).toEqual({
      kind: 'complete',
      record: { source: 'codex', body: { paneKey: PANE, payload: '{}' } }
    })
  })

  it('treats a record without its end line as still being written', () => {
    const full = record('{"a":1}')
    expect(parseAgentHookInboxRecord(Buffer.from(full.slice(0, -2))).kind).toBe('incomplete')
    expect(parseAgentHookInboxRecord(Buffer.from('{"a":1}')).kind).toBe('incomplete')
  })

  it('never lets a trailer set transport fields, and keeps the first value of a key', () => {
    const parsed = parseAgentHookInboxRecord(
      Buffer.from(
        `{}\norca-hook-record v1\nsource=codex\npaneKey=${PANE}\npaneKey=tab-2:x\nisReplay=true\npayload=forged\nconnectionId=c\norca-hook-end\n`
      )
    )
    expect(parsed).toEqual({
      kind: 'complete',
      record: { source: 'codex', body: { paneKey: PANE, payload: '{}' } }
    })
  })

  it('rejects a complete record with no source or pane', () => {
    expect(parseAgentHookInboxRecord(Buffer.from('{}\norca-hook-end\n')).kind).toBe('invalid')
    expect(
      parseAgentHookInboxRecord(
        Buffer.from('{}\norca-hook-record v1\nsource=codex\norca-hook-end\n')
      ).kind
    ).toBe('invalid')
  })
})

describe('AgentHookInbox', () => {
  it('replays the backlog found at open, then treats later records as live', () => {
    const dir = tempInbox()
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '10.0.rec'), record('{"n":"backlog"}'))
    const { inbox, ingested, opened: ok } = openInbox(dir)
    expect(ok).toBe(true)
    inbox.drain()
    writeFileSync(join(dir, '11.0.rec'), record('{"n":"live"}'))
    inbox.drain()
    expect(ingested.map(({ record: r, isReplay }) => [r.body.payload, isReplay])).toEqual([
      ['{"n":"backlog"}', true],
      ['{"n":"live"}', false]
    ])
    expect(readdirSync(dir)).toEqual([])
  })

  it('drains in commit order: mtime, then numeric pid and sequence', () => {
    const dir = tempInbox()
    const { inbox, ingested } = openInbox(dir)
    const at = Date.now() / 1000
    const files: [string, number][] = [
      ['1000.0.rec', at], // same mtime as 999.*: numeric pid must win over lexical order
      ['999.1.rec', at],
      ['999.0.rec', at],
      ['5.0.rec', at + 1]
    ]
    for (const [name, mtime] of files) {
      writeFileSync(join(dir, name), record(JSON.stringify({ name })))
      utimesSync(join(dir, name), mtime, mtime)
    }
    inbox.drain()
    expect(ingested.map(({ record: r }) => JSON.parse(r.body.payload).name)).toEqual([
      '999.0.rec',
      '999.1.rec',
      '1000.0.rec',
      '5.0.rec'
    ])
  })

  it('leaves a record that is still being written, and admits it once complete', () => {
    const dir = tempInbox()
    const { inbox, ingested } = openInbox(dir)
    const full = record('{"n":1}')
    writeFileSync(join(dir, '7.0.rec'), full.slice(0, 12))
    inbox.drain()
    expect(ingested).toEqual([])
    expect(readdirSync(dir)).toEqual(['7.0.rec'])
    writeFileSync(join(dir, '7.0.rec'), full)
    inbox.drain()
    expect(ingested).toHaveLength(1)
  })

  it('discards a torn record once its writer is certainly gone, and records past the replay horizon', () => {
    const dir = tempInbox()
    let now = Date.now()
    const { inbox, ingested } = openInbox(dir, () => now)
    writeFileSync(join(dir, '1.0.rec'), '{"torn":')
    writeFileSync(join(dir, '2.0.rec'), record('{"n":"ancient"}'))
    const ancient = (now - AGENT_HOOK_INBOX_MAX_RECORD_AGE_MS - 60_000) / 1000
    utimesSync(join(dir, '2.0.rec'), ancient, ancient)
    inbox.drain()
    expect(readdirSync(dir)).toEqual(['1.0.rec'])
    now += AGENT_HOOK_INBOX_TORN_RECORD_MAX_AGE_MS + 60_000
    inbox.drain()
    expect(readdirSync(dir)).toEqual([])
    expect(ingested).toEqual([])
  })

  it('admits a record at most once when another drainer claims it first', () => {
    const dir = tempInbox()
    const first = openInbox(dir)
    const second = openInbox(dir)
    writeFileSync(join(dir, '3.0.rec'), record('{"n":1}'))
    first.inbox.drain()
    second.inbox.drain()
    expect(first.ingested.length + second.ingested.length).toBe(1)
  })

  it('keeps draining after an ingest throws', () => {
    const dir = tempInbox()
    const seen: string[] = []
    const inbox = new AgentHookInbox(dir, ({ body }) => {
      seen.push(body.payload)
      if (body.payload === '{"n":1}') {
        throw new Error('bad record')
      }
    })
    opened.push(inbox)
    inbox.open()
    const at = Date.now() / 1000
    writeFileSync(join(dir, '1.0.rec'), record('{"n":1}'))
    utimesSync(join(dir, '1.0.rec'), at, at)
    writeFileSync(join(dir, '2.0.rec'), record('{"n":2}'))
    utimesSync(join(dir, '2.0.rec'), at + 1, at + 1)
    inbox.drain()
    expect(seen).toEqual(['{"n":1}', '{"n":2}'])
  })

  it('delivers a record committed while no one calls drain', async () => {
    const dir = tempInbox()
    const { ingested } = openInbox(dir)
    writeFileSync(join(dir, '4.0.rec'), record('{"n":"unprompted"}'))
    // The watcher usually lands in milliseconds; the one-second sweep guarantees it regardless.
    await expect.poll(() => ingested.length, { timeout: 3_000, interval: 10 }).toBe(1)
  })

  it.skipIf(process.platform === 'win32')('refuses an inbox path that is a symlink', () => {
    const root = mkdtempSync(join(tmpdir(), 'orca-hook-inbox-link-'))
    const target = join(root, 'elsewhere')
    mkdirSync(target)
    const dir = join(root, 'hook-inbox')
    symlinkSync(target, dir)
    try {
      expect(openInbox(dir).opened).toBe(false)
    } finally {
      unlinkSync(dir)
      rmSync(root, { recursive: true, force: true })
    }
  })

  it.skipIf(process.platform === 'win32')(
    'replays a large backlog in slices off the caller, in commit order',
    async () => {
      const endpointDir = mkdtempSync(join(tmpdir(), 'orca-hook-inbox-backlog-'))
      const dir = join(endpointDir, 'hook-inbox')
      mkdirSync(dir, { recursive: true, mode: 0o700 })
      const total = 1_207
      const at = Date.now() / 1000 - 60
      for (let index = 0; index < total; index += 1) {
        writeFileSync(join(dir, `1.${index}.rec`), record(JSON.stringify({ index })))
        utimesSync(join(dir, `1.${index}.rec`), at + index / 1000, at + index / 1000)
      }
      const seen: { index: number; isReplay: boolean }[] = []
      const inbox = openAgentHookInbox({
        endpointDir,
        ingest: (_source, body, { isReplay }) =>
          seen.push({ index: JSON.parse(String(body.payload)).index, isReplay })
      })
      expect(inbox).not.toBeNull()
      opened.push(inbox!)
      // Opening returns before replaying anything: the startup path is not held for the backlog.
      expect(seen).toHaveLength(0)
      await expect.poll(() => seen.length, { timeout: 25_000, interval: 10 }).toBe(total)
      expect(seen.map(({ index }) => index)).toEqual([...Array(total).keys()])
      expect(seen.every(({ isReplay }) => isReplay)).toBe(true)
    },
    30_000
  )

  it('stops draining once closed', () => {
    const dir = tempInbox()
    const { inbox, ingested } = openInbox(dir)
    inbox.close()
    writeFileSync(join(dir, '6.0.rec'), record('{}'))
    inbox.drain()
    expect(ingested).toEqual([])
    expect(readdirSync(dir)).toEqual(['6.0.rec'])
  })
})
