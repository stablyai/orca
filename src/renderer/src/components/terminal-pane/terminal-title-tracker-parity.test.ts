import { readFileSync } from 'node:fs'
// Feed identical bytes through renderer parsing and main’s OSC-9999-strip/title-tracker path; ordered title/status facts must match for mobile, waiters and desktop consumers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createAgentStatusOscProcessor } from '../../../../shared/agent-status-osc'
import { createTerminalTitleTracker } from '../../../../shared/terminal-output-side-effects'
import { createPtyOutputProcessor } from './pty-output-processor'

const ESC = '\x1b'
const BEL = '\x07'
const ST = `${ESC}\\`

type TitleFactEvent =
  | { kind: 'title'; normalized: string; raw: string }
  | { kind: 'became-working' }
  | { kind: 'became-idle'; title: string }
  | { kind: 'agent-exited' }
  | { kind: 'bell' }

type TitleFactPath = {
  events: TitleFactEvent[]
  feed: (chunk: string) => void
  flush: () => void
}

// Delay drain across chunks to expose queued decisions made before lastEmittedTitle advances.
function createRendererPath(initialTitle?: string, deferDrain = false): TitleFactPath {
  const events: TitleFactEvent[] = []
  const processor = createPtyOutputProcessor({
    onTitleChange: (normalized, raw) => events.push({ kind: 'title', normalized, raw }),
    onAgentBecameWorking: () => events.push({ kind: 'became-working' }),
    onAgentBecameIdle: (title) => events.push({ kind: 'became-idle', title }),
    onAgentExited: () => events.push({ kind: 'agent-exited' }),
    onBell: () => events.push({ kind: 'bell' }),
    initialAgentTitle: initialTitle
  })
  const callbacks = { onData: () => {} }
  return {
    events,
    feed(chunk: string): void {
      processor.processData(chunk, callbacks)
      // Flush renderer’s deferred effects so both paths compare each chunk at the same fake time.
      if (!deferDrain) {
        processor.flushPendingSideEffects()
      }
    },
    flush: () => processor.flushPendingSideEffects()
  }
}

function createMainPath(initialTitle?: string): TitleFactPath {
  const events: TitleFactEvent[] = []
  // Match runtime ordering: strip OSC 9999 status before tracking titles.
  const processAgentStatusChunk = createAgentStatusOscProcessor()
  const tracker = createTerminalTitleTracker(
    {
      onTitle: (normalized, raw) => events.push({ kind: 'title', normalized, raw }),
      onAgentBecameWorking: () => events.push({ kind: 'became-working' }),
      onAgentBecameIdle: (title) => events.push({ kind: 'became-idle', title }),
      onAgentExited: () => events.push({ kind: 'agent-exited' }),
      onBell: () => events.push({ kind: 'bell' })
    },
    initialTitle !== undefined ? { initialTitle } : undefined
  )
  return {
    events,
    feed(chunk: string): void {
      tracker.handleChunk(processAgentStatusChunk(chunk).cleanData)
    },
    // Why: main applies every title inline, so there is nothing to defer.
    flush: () => {}
  }
}

type ChunkFeed = { feed: (chunk: string) => void }

function feedBoth(paths: { renderer: ChunkFeed; main: ChunkFeed }, chunk: string): void {
  paths.renderer.feed(chunk)
  paths.main.feed(chunk)
}

describe('main title tracker parity with the renderer transport processor', () => {
  let paths: { renderer: TitleFactPath; main: TitleFactPath }

  beforeEach(() => {
    vi.useFakeTimers()
    paths = { renderer: createRendererPath(), main: createMainPath() }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('agrees on captured OMP native frames before and after owner rebranding', () => {
    const captured = readFileSync(
      new URL('../../../../main/runtime/__fixtures__/omp-native-title-win32.txt', import.meta.url),
      'utf8'
    )
    feedBoth(paths, captured)
    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.some((event) => event.kind === 'became-working')).toBe(true)
    expect(paths.main.events.some((event) => event.kind === 'became-idle')).toBe(true)
    feedBoth(paths, captured.replaceAll(']0;π', ']0;OMP'))
    expect(paths.main.events).toEqual(paths.renderer.events)
  })

  it('derives identical facts from a coalesced spinner+idle chunk (issue #1083)', () => {
    // One PTY batch can contain working spinner and idle title; last-title-only readers miss the turn.
    const chunk =
      `${ESC}]0;⠋ π - cwd${BEL}response text\r\n` +
      `${ESC}]0;⠙ π - cwd${BEL}more text\r\n` +
      `${ESC}]0;π - cwd${BEL}`
    feedBoth(paths, chunk)

    expect(paths.main.events).toEqual(paths.renderer.events)
    const kinds = paths.main.events.map((event) => event.kind)
    expect(kinds).toContain('became-working')
    expect(kinds.indexOf('became-working')).toBeLessThan(kinds.indexOf('became-idle'))
  })

  // WSL/ConPTY OMP uses static markers instead of animation; both paths must still see working → idle (#13890).
  it('derives identical facts from static OMP WSL state titles', () => {
    const chunk = `${ESC}]0;zsh | π : cwd${BEL}response text\r\n` + `${ESC}]0;zsh | π > cwd${BEL}`
    feedBoth(paths, chunk)

    expect(paths.main.events).toEqual(paths.renderer.events)
    const kinds = paths.main.events.map((event) => event.kind)
    expect(kinds).toContain('became-working')
    expect(kinds.indexOf('became-working')).toBeLessThan(kinds.indexOf('became-idle'))
  })

  // Stale OMP markers must leave working even when titles stop mid-turn.
  it('clears a stale static OMP working title in both paths', () => {
    feedBoth(paths, `${ESC}]0;zsh | π : cwd${BEL}`)
    feedBoth(paths, 'title-free output')
    vi.advanceTimersByTime(3_000)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toContainEqual({
      kind: 'became-idle',
      title: 'zsh | π > cwd'
    })
  })

  it('derives identical facts from BEL- and ST-terminated titles', () => {
    feedBoth(paths, `${ESC}]2;Codex working${ST}body bytes`)
    feedBoth(paths, `${ESC}]0;Codex done${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toContainEqual({ kind: 'became-idle', title: 'Codex done' })
  })

  // Hookless Cursor’s bare literal supplies identity once without becoming agent state (#10258).
  it('emits the bare cursor-agent native title once in both paths', () => {
    feedBoth(paths, `${ESC}]0;Cursor Agent${BEL}`)
    feedBoth(paths, `${ESC}]0;Cursor Agent${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toEqual([
      { kind: 'title', normalized: 'Cursor Agent', raw: 'Cursor Agent' }
    ])
  })

  it('lets a synthesized Cursor title follow the native literal in both paths', () => {
    feedBoth(paths, `${ESC}]0;Cursor Agent${BEL}`)
    feedBoth(paths, `${ESC}]0;⠋ Cursor Agent${BEL}`)
    feedBoth(paths, `${ESC}]0;Cursor Agent${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.map((event) => event.kind)).toEqual([
      'title',
      'title',
      'became-working'
    ])
  })

  it('keeps a restored native Cursor title identity-only before synthesized work', () => {
    const restoredPaths = {
      renderer: createRendererPath('Cursor Agent'),
      main: createMainPath('Cursor Agent')
    }

    feedBoth(restoredPaths, `${ESC}]0;Cursor Agent${BEL}`)
    expect(restoredPaths.main.events).toEqual([])

    feedBoth(restoredPaths, `${ESC}]0;⠋ Cursor Agent${BEL}`)

    expect(restoredPaths.main.events).toEqual(restoredPaths.renderer.events)
    expect(restoredPaths.main.events).toEqual([
      { kind: 'title', normalized: '⠋ Cursor Agent', raw: '⠋ Cursor Agent' },
      { kind: 'became-working' }
    ])
  })

  it('keeps native/synthesized Cursor title order inside one coalesced chunk', () => {
    feedBoth(
      paths,
      `${ESC}]0;Cursor Agent${BEL}${ESC}]0;⠋ Cursor Agent${BEL}${ESC}]0;Cursor Agent${BEL}`
    )

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toEqual([
      { kind: 'title', normalized: 'Cursor Agent', raw: 'Cursor Agent' },
      { kind: 'title', normalized: '⠋ Cursor Agent', raw: '⠋ Cursor Agent' },
      { kind: 'became-working' }
    ])
  })

  it('drops the bare cursor-agent native title in both paths', () => {
    feedBoth(paths, `${ESC}]0;⠋ Cursor Agent${BEL}`)
    feedBoth(paths, `${ESC}]0;Cursor Agent${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    const titles = paths.main.events.filter((event) => event.kind === 'title')
    expect(titles).toEqual([{ kind: 'title', normalized: '⠋ Cursor Agent', raw: '⠋ Cursor Agent' }])
  })

  // After shell title replaces it, Cursor’s bare literal must be emitted again to recover reentry identity (#10258).
  it('re-emits the native literal after a non-Cursor title took the pane', () => {
    feedBoth(paths, `${ESC}]0;Cursor Agent${BEL}`)
    feedBoth(paths, `${ESC}]0;zsh${BEL}${ESC}]0;Cursor Agent${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.filter((event) => event.kind === 'title')).toEqual([
      { kind: 'title', normalized: 'Cursor Agent', raw: 'Cursor Agent' },
      { kind: 'title', normalized: 'zsh', raw: 'zsh' },
      { kind: 'title', normalized: 'Cursor Agent', raw: 'Cursor Agent' }
    ])
  })

  // Drain together so queued chunks cannot compare against an already-stale predecessor.
  it('re-emits the native literal across chunks that drain together', () => {
    const deferred = {
      renderer: createRendererPath(undefined, true),
      main: createMainPath()
    }

    feedBoth(deferred, `${ESC}]0;Cursor Agent${BEL}`)
    // Seed emitted-title memory with the literal before later chunks expose stale-predecessor decisions.
    deferred.renderer.flush()
    feedBoth(deferred, `${ESC}]0;zsh${BEL}`)
    feedBoth(deferred, `${ESC}]0;Cursor Agent${BEL}`)
    deferred.renderer.flush()

    expect(deferred.main.events).toEqual(deferred.renderer.events)
    expect(deferred.main.events.filter((event) => event.kind === 'title')).toHaveLength(3)
  })

  it('clears a stale working title after the 3s timeout in both paths', () => {
    feedBoth(paths, `${ESC}]0;. Claude working${BEL}`)
    feedBoth(paths, 'output with no title\r\n')

    vi.advanceTimersByTime(3_000)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.at(-1)).toEqual({ kind: 'became-idle', title: 'Claude' })
  })

  it('keeps the stale-title timer unperturbed by pure OSC 9999 status chunks', () => {
    feedBoth(paths, `${ESC}]0;Codex working${BEL}`)
    feedBoth(paths, 'plain output arms the timer\r\n')

    vi.advanceTimersByTime(2_000)
    // Status-only chunks strip empty and must neither arm nor restart stale probes.
    feedBoth(paths, `${ESC}]9999;{"state":"working","agentType":"codex"}${BEL}`)
    vi.advanceTimersByTime(1_000)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.at(-1)).toEqual({ kind: 'became-idle', title: 'Codex' })
  })

  it('ignores a title split across chunk boundaries in both paths', () => {
    feedBoth(paths, `${ESC}]0;split-ti`)
    feedBoth(paths, `tle${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toEqual([])
  })

  it('orders a real BEL after the same chunk titles in both paths', () => {
    feedBoth(paths, `${ESC}]0;⠋ Claude working${BEL}done text${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.map((event) => event.kind)).toEqual([
      'title',
      'became-working',
      'bell'
    ])
  })

  it('never reports an OSC-terminator BEL as a bell, even spanning chunks', () => {
    feedBoth(paths, `${ESC}]0;par`)
    feedBoth(paths, `tial title${BEL}`)
    feedBoth(paths, `${ESC}]2;st-terminated${ST}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events.filter((event) => event.kind === 'bell')).toEqual([])
  })

  it('treats a BEL after a CAN-cancelled OSC as a real bell in both paths', () => {
    // ECMA-48 CAN aborts the in-progress OSC; the next BEL is a real bell.
    feedBoth(paths, `${ESC}]0;truncated`)
    feedBoth(paths, `\x18${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toEqual([{ kind: 'bell' }])
  })

  it('keeps bells suppressed inside OSC 9999 status payloads in both paths', () => {
    feedBoth(paths, `${ESC}]9999;{"state":"working","agentType":"codex"}${BEL}`)

    expect(paths.main.events).toEqual(paths.renderer.events)
    expect(paths.main.events).toEqual([])
  })
})
