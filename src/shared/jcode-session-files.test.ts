import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const { homedirMock, closeFailureMock } = vi.hoisted(() => ({
  homedirMock: vi.fn<() => string>(),
  closeFailureMock: vi.fn<() => void>()
}))

vi.mock(import('node:fs'), async (importOriginal) => {
  const actual = await importOriginal()
  return {
    ...actual,
    closeSync(fd: number): void {
      actual.closeSync(fd)
      closeFailureMock()
    }
  }
})

vi.mock(import('node:os'), async (importOriginal) => {
  const actual = await importOriginal()
  return { ...actual, homedir: homedirMock }
})

import {
  createJcodeSessionMetadataCache,
  readJcodeSessionMetadata,
  readLastJcodeUserPromptFromHookPayload
} from './jcode-session-files'

// Selected metadata from Jcode 0.99.0 captures; mutations below are negative controls.
const rootMetadata = {
  id: 'session_tigress_1792603131095_636843aadc1b740b',
  parent_id: null,
  short_name: 'tigress',
  title: 'Run ls in the cwd with the bash tool, then reply with the single…',
  status: 'Active'
}
const workerMetadata = {
  id: 'session_retriever_1792603161400_81ad62e08be2201b',
  parent_id: rootMetadata.id,
  short_name: 'retriever',
  title: 'Reply with exactly the text worker-ok. Do not use any tools.',
  status: 'Active'
}

describe('Jcode session metadata', () => {
  let home: string
  let sessions: string

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'orca-jcode-metadata-'))
    vi.stubEnv('JCODE_HOME', home)
    sessions = join(home, 'sessions')
    mkdirSync(sessions)
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
    closeFailureMock.mockReset()
    rmSync(home, { recursive: true, force: true })
  })

  function writeMetadata(value: unknown, id = workerMetadata.id): void {
    writeFileSync(join(sessions, `${id}.json`), JSON.stringify(value))
  }

  it('never throws when closing the metadata file fails', () => {
    writeMetadata(workerMetadata)
    closeFailureMock.mockImplementationOnce(() => {
      throw new Error('close failed')
    })
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 0)
    ).toEqual({
      id: workerMetadata.id,
      parentId: rootMetadata.id,
      shortName: 'retriever',
      title: workerMetadata.title,
      closed: false
    })
  })

  it('trims session and parent ids before lookup and return', () => {
    // Negative control: whitespace around captured ids.
    writeMetadata({
      ...workerMetadata,
      id: ` ${workerMetadata.id}\n`,
      parent_id: `\t${rootMetadata.id} `
    })
    expect(
      readJcodeSessionMetadata(` ${workerMetadata.id}\n`, createJcodeSessionMetadataCache(), 0)
    ).toMatchObject({ id: workerMetadata.id, parentId: rootMetadata.id })
  })

  it('reads captured ancestry and selected metadata without retaining session content', () => {
    const cache = createJcodeSessionMetadataCache()
    writeMetadata(rootMetadata, rootMetadata.id)
    writeMetadata({ ...workerMetadata, messages: ['private'], environment: { private: 'value' } })
    expect(readJcodeSessionMetadata(rootMetadata.id, cache, 0)).toEqual({
      id: rootMetadata.id,
      parentId: null,
      shortName: 'tigress',
      title: rootMetadata.title,
      closed: false
    })
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 0)).toEqual({
      id: 'session_retriever_1792603161400_81ad62e08be2201b',
      parentId: 'session_tigress_1792603131095_636843aadc1b740b',
      shortName: 'retriever',
      title: 'Reply with exactly the text worker-ok. Do not use any tools.',
      closed: false
    })
    expect(readJcodeSessionMetadata('../../etc/passwd', cache, 0)).toBeNull()
    expect(
      readJcodeSessionMetadata('session_bonehound_1792604760755_aecccf6c235843ea', cache, 0)
    ).toBeNull()
  })

  it.each(
    [
      { id: workerMetadata.id },
      { ...workerMetadata, id: rootMetadata.id },
      [],
      null,
      { ...workerMetadata, parent_id: 1 },
      { ...workerMetadata, parent_id: '' },
      { ...workerMetadata, parent_id: '../../root' }
    ].map((document) => ({ document }))
  )('rejects invalid documents: %j', ({ document }) => {
    writeMetadata(document)
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 0)
    ).toBeNull()
  })

  it('rejects partial JSON and oversized files', () => {
    const path = join(sessions, `${workerMetadata.id}.json`)
    writeFileSync(path, '{"id":')
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 0)
    ).toBeNull()
    writeFileSync(path, JSON.stringify(workerMetadata) + ' '.repeat(8 * 1024 * 1024))
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 0)
    ).toBeNull()
  })

  it.each([
    ['Closed', true],
    [{ Crashed: { message: 'Client disconnected while processing' } }, true],
    ['future-status', false]
  ])('maps closed status %j to %s', (status, closed) => {
    writeMetadata({ ...workerMetadata, status })
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 0)?.closed
    ).toBe(closed)
  })

  it('normalizes optional labels with existing field caps', () => {
    writeMetadata({
      ...workerMetadata,
      short_name: `  ${'s'.repeat(100)}`,
      title: `\n${'t'.repeat(300)}`
    })
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 0)
    ).toMatchObject({
      shortName: 's'.repeat(40),
      title: 't'.repeat(160)
    })
  })

  it('expires misses at 250 ms and positive entries at 1000 ms using the default clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
    const cache = createJcodeSessionMetadataCache()
    expect(readJcodeSessionMetadata(workerMetadata.id, cache)).toBeNull()
    writeMetadata(workerMetadata)
    vi.setSystemTime(249)
    expect(readJcodeSessionMetadata(workerMetadata.id, cache)).toBeNull()
    vi.setSystemTime(250)
    expect(readJcodeSessionMetadata(workerMetadata.id, cache)?.closed).toBe(false)
    writeMetadata({ ...workerMetadata, status: 'Closed' })
    vi.setSystemTime(1249)
    expect(readJcodeSessionMetadata(workerMetadata.id, cache)?.closed).toBe(false)
    vi.setSystemTime(1250)
    expect(readJcodeSessionMetadata(workerMetadata.id, cache)?.closed).toBe(true)
  })

  it('isolates caches and resolved session directories', () => {
    writeMetadata(workerMetadata)
    const cache = createJcodeSessionMetadataCache()
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 0)?.closed).toBe(false)
    writeMetadata({ ...workerMetadata, status: 'Closed' })
    expect(
      readJcodeSessionMetadata(workerMetadata.id, createJcodeSessionMetadataCache(), 1)?.closed
    ).toBe(true)
    vi.stubEnv('JCODE_HOME', join(home, 'other-host'))
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 1)).toBeNull()
    vi.stubEnv('JCODE_HOME', home)
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 2)?.closed).toBe(false)
  })

  it('evicts the oldest entry once 256 entries are cached, including misses', () => {
    const cache = createJcodeSessionMetadataCache()
    writeMetadata(workerMetadata)
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 0)?.closed).toBe(false)
    for (let index = 0; index < 255; index++) {
      expect(readJcodeSessionMetadata(`session_missing_${index}`, cache, 0)).toBeNull()
    }
    writeMetadata({ ...workerMetadata, status: 'Closed' })
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 1)?.closed).toBe(false)
    expect(readJcodeSessionMetadata('session_overflow', cache, 1)).toBeNull()
    expect(readJcodeSessionMetadata(workerMetadata.id, cache, 1)?.closed).toBe(true)
  })
})

describe('shared jcode-session-files', () => {
  let homeDir: string
  let sessionsDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'orca-jcode-sessions-'))
    homedirMock.mockReturnValue(homeDir)
    sessionsDir = join(homeDir, '.jcode', 'sessions')
    mkdirSync(sessionsDir, { recursive: true })
  })

  afterEach(() => {
    vi.unstubAllEnvs()
    vi.clearAllMocks()
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('returns the last real user prompt from the live journal', () => {
    writeFileSync(
      join(sessionsDir, 'session_a_1.journal.jsonl'),
      [
        JSON.stringify({
          meta: { id: 'session_a_1' },
          append_messages: [
            {
              id: 'm1',
              role: 'user',
              display_role: 'system',
              content: [{ type: 'text', text: '<system-reminder>injected</system-reminder>' }]
            },
            { id: 'm2', role: 'user', content: [{ type: 'text', text: 'fix the flaky test' }] }
          ]
        })
      ].join('\n')
    )
    const found = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_a_1' })
    expect(found?.text).toBe('fix the flaky test')
    expect(found?.interactionKey).toContain('jcode-transcript')
  })

  it('falls back to the consolidated session doc when the journal is missing', () => {
    writeFileSync(
      join(sessionsDir, 'session_b_2.json'),
      JSON.stringify({
        id: 'session_b_2',
        messages: [
          { id: 'm1', role: 'user', display_role: 'system', content: 'injected context' },
          { id: 'm2', role: 'user', content: [{ type: 'text', text: 'hello jcode' }] },
          { id: 'm3', role: 'assistant', content: 'hi' }
        ]
      })
    )
    const found = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_b_2' })
    expect(found?.text).toBe('hello jcode')
  })

  it('skips injected context and returns null when only system content exists', () => {
    writeFileSync(
      join(sessionsDir, 'session_c_3.journal.jsonl'),
      JSON.stringify({
        meta: { id: 'session_c_3' },
        append_messages: [
          {
            id: 'm1',
            role: 'user',
            display_role: 'system',
            content: [{ type: 'text', text: '<system-reminder>context</system-reminder>' }]
          }
        ]
      })
    )
    expect(readLastJcodeUserPromptFromHookPayload({ session_id: 'session_c_3' })).toBeNull()
  })

  it('keys a prompt by its place in the file, so appends do not remint the key', () => {
    // EOF-relative windows shift on append; region-local keys reminted unchanged prompts and bypassed turn_end dedupe, duplicating prompt telemetry.
    const journalPath = join(sessionsDir, 'session_d_4.journal.jsonl')
    const filler = (index: number) =>
      JSON.stringify({
        meta: { id: 'session_d_4' },
        append_messages: [],
        index,
        pad: 'x'.repeat(400)
      })
    const prompt = JSON.stringify({
      meta: { id: 'session_d_4' },
      append_messages: [{ id: 'm1', role: 'user', content: [{ type: 'text', text: 'keep me' }] }]
    })
    // Place the prompt deep in the second 64 KiB window so appends change its region-local line index.
    const before = Array.from({ length: 200 }, (_, index) => filler(index))
    const after = Array.from({ length: 100 }, (_, index) => filler(1000 + index))

    writeFileSync(journalPath, [...before, prompt, ...after].join('\n'))
    const firstRead = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_d_4' })

    writeFileSync(journalPath, [...before, prompt, ...after, filler(9999)].join('\n'))
    const afterAppend = readLastJcodeUserPromptFromHookPayload({ session_id: 'session_d_4' })

    expect(firstRead?.text).toBe('keep me')
    expect(afterAppend?.text).toBe('keep me')
    expect(afterAppend?.interactionKey).toBe(firstRead?.interactionKey)
  })

  it('rejects traversal to a file containing a user prompt', () => {
    writeFileSync(
      join(homeDir, 'escaped.json'),
      JSON.stringify({ messages: [{ role: 'user', content: 'outside the sessions directory' }] })
    )
    expect(readLastJcodeUserPromptFromHookPayload({ session_id: '../../escaped' })).toBeNull()
    expect(readLastJcodeUserPromptFromHookPayload({})).toBeNull()
  })
})
