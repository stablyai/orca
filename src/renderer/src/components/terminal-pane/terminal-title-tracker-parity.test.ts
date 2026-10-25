import { readFileSync } from 'node:fs'
// Why: Phase 3 slice 1 of terminal-side-effect-authority.md runs a per-PTY
// title tracker in main alongside the renderer transport's byte parser. Both
// must derive IDENTICAL ordered title/status facts from the same bytes, or
// main-side consumers (tui-idle waiters, worktree ps, mobile titles) drift
// from what the renderer shows. This harness feeds identical byte fixtures
// through the renderer `createPtyOutputProcessor` and through main's
// consumption shape (OSC 9999 strip → shared title tracker) and asserts the
// event sequences match.
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

// Why deferDrain: flushing per chunk hides schedule-vs-drain divergence, because the renderer
// decides what to queue against a `lastEmittedTitle` that only later chunks advance.
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
      // Why: the renderer defers side effects behind a setTimeout(0) drain to
      // protect xterm paint. Flush synchronously so both paths observe each
      // chunk at the same fake-timer instant.
      if (!deferDrain) {
        processor.flushPendingSideEffects()
      }
    },
    flush: () => processor.flushPendingSideEffects()
  }
}

function createMainPath(initialTitle?: string): TitleFactPath {
  const events: TitleFactEvent[] = []
  // Why: mirrors OrcaRuntimeService.onPtyData — the per-PTY OSC 9999
  // processor strips status payloads before the title tracker sees the chunk.
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
    // One realistic node-pty batch: Pi's 80ms spinner frames plus agent_end's
    // trailing idle title. A last-title reader sees only the idle title and
    // never observes the working state.
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

  // Why: OMP 17.2.12+ cannot animate under WSL/ConPTY, so it emits static state markers
  // instead of braille frames (#13890). Both paths must see the same working→idle turn.
  it('derives identical facts from static OMP WSL state titles', () => {
    const chunk = `${ESC}]0;zsh | π : cwd${BEL}response text\r\n` + `${ESC}]0;zsh | π > cwd${BEL}`
    feedBoth(paths, chunk)

    expect(paths.main.events).toEqual(paths.renderer.events)
    const kinds = paths.main.events.map((event) => event.kind)
    expect(kinds).toContain('became-working')
    expect(kinds.indexOf('became-working')).toBeLessThan(kinds.indexOf('became-idle'))
  })

  // Why: an OMP pane that stops emitting titles mid-turn must still leave working, or the
  // stale native marker keeps the pane — and its synthetic spinner — pinned to working.
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

  // Why: #10258 — a hookless Cursor pane's only identity is the bare literal, so both
  // paths must emit it once (never as an agent state) before the repeats are dropped.
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

  // Why: once the shell prompt repaints the title, the literal is again the pane's only Cursor
  // identity — dropping it there would leave a re-entered cursor-agent with no row (#10258).
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

  // Why one flush: the renderer prunes titles when the chunk is scheduled but only advances its
  // emitted-title memory on drain, so chunks that drain together must not decide against a
  // predecessor that is already stale.
  it('re-emits the native literal across chunks that drain together', () => {
    const deferred = {
      renderer: createRendererPath(undefined, true),
      main: createMainPath()
    }

    feedBoth(deferred, `${ESC}]0;Cursor Agent${BEL}`)
    // Why drain here: it leaves the renderer's emitted-title memory on the literal, which is
    // exactly the stale predecessor the next two chunks must not be judged against.
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
    // Why: a chunk that is ONLY an Orca status payload strips to empty
    // cleanData; neither path may restart (or newly arm) the stale probe.
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
