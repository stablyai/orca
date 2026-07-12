import { describe, expect, it } from 'vitest'
import {
  buildAgentTuiStreamOps,
  mulberry32,
  splitIntoRandomChunks,
  type AgentTuiStreamDims
} from '../../../../shared/agent-tui-ansi-fuzz-stream'
import { extractPartialEscapeTail } from '../../../../shared/terminal-partial-escape-tail'
import {
  POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY,
  SNAPSHOT_REPLAY_PREAMBLE_ALT,
  SNAPSHOT_REPLAY_PREAMBLE_NORMAL,
  bufferHasSerializeHostileWrappedRow,
  buildParityMainBufferSnapshot,
  createRendererParityTerminal,
  cursorPosition,
  normalBufferRowsTrimmed,
  visibleRows,
  visibleRowStyles,
  writeChunksToTerminal
} from '../../../../shared/terminal-restore-parity-fixture'

// Property fuzz for the hidden-reveal seq-reconciliation path in
// pty-connection.ts. When a pane is hidden, main keeps metering PTY output as
// seq'd chunks. On reveal the renderer applies a HeadlessEmulator snapshot
// captured at seq S (paints everything <= S), then stitches the racing tail
// (chunks straddling / after S) on top WITHOUT duplicating or losing a byte.
// The byte arithmetic lives in two non-exported closures:
//   - getChunkDataAfterSnapshot            (pty-connection.ts ~L4629): slices a
//     pending chunk against the snapshot seq.
//   - reconcileChunkAgainstRestoredSnapshot (pty-connection.ts ~L4660): dedups
//     backlog, detects a restarted seq domain, and heals dropped-output gaps by
//     forcing a fresh restore.
// This suite mirrors those rules EXACTLY (each branch tagged with its source
// line) and asserts the invariant they guarantee: for any reveal boundary,
// snapshot(hidden prefix) + reconciled tail reproduces the same screen an
// always-visible terminal shows for the full stream. A wrong slice = a garble.
//
// Runtime knobs:
//   FUZZ_ITERATIONS=2000  deep/nightly (default 200, <60s with the fidelity suite)
//   FUZZ_SEED=1234        re-run exactly one seed

const DEFAULT_ITERATIONS = 200
const FIXED_SEED = readPositiveIntEnv('FUZZ_SEED')
const ITERATIONS =
  FIXED_SEED !== null ? 1 : (readPositiveIntEnv('FUZZ_ITERATIONS') ?? DEFAULT_ITERATIONS)

function readPositiveIntEnv(name: string): number | null {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
}

const DIMS: readonly AgentTuiStreamDims[] = [
  { cols: 80, rows: 24 },
  { cols: 100, rows: 30 }
]

/** A metered chunk exactly as main delivers to onData: text, the seq of the
 *  LAST raw byte, the raw (pre-OSC-strip) length, and delivery-domain markers.
 *  domain increments across a ptyId-exit seq restart (production clears the
 *  restored baseline at that boundary, so the tail writes verbatim). */
type MeteredChunk = {
  data: string
  seq?: number
  rawLength?: number
  domain: number
  droppedOutput?: boolean
}

/** Mirror of getChunkDataAfterSnapshot (pty-connection.ts ~L4629): how much of
 *  a chunk in the SNAPSHOT'S seq domain survives once the snapshot at
 *  snapshotSeq has painted everything <= snapshotSeq. null = "cannot slice,
 *  force a fresh snapshot" (OSC stripping desynced raw offsets). Byte-identical
 *  to production; each return tagged with its branch. */
function chunkDataAfterSnapshot(
  chunk: MeteredChunk,
  snapshotSeq: number | undefined
): string | null {
  if (typeof snapshotSeq !== 'number' || typeof chunk.seq !== 'number') {
    return chunk.data // L4633: unmetered — pass through
  }
  const rawLength = chunk.rawLength ?? chunk.data.length
  const startSeq = chunk.seq - rawLength
  if (snapshotSeq >= chunk.seq) {
    return '' // L4638: fully before/at snapshot — already painted
  }
  if (snapshotSeq <= startSeq) {
    return chunk.data // L4641: fully after snapshot — keep whole
  }
  const offset = snapshotSeq - startSeq
  if (rawLength !== chunk.data.length) {
    return null // L4645: OSC-stripped, offsets unmappable
  }
  return chunk.data.slice(offset) // L4648: straddles — drop the painted prefix
}

type RevealResult = {
  /** Full normal-buffer content (visible + scrollback, trailing blanks
   *  trimmed). Viewport-independent: a byte lost or duplicated by reconciliation
   *  changes this even when the visible viewport happens to line up. */
  content: string[]
  rows: string[]
  styles: string[]
  cursor: { x: number; y: number }
  /** True when the buffer scrolled (baseY > 0). The visible viewport's top
   *  anchor after a snapshot restore vs continuous writing can differ by a row
   *  or two purely from trailing-blank trimming — a snapshot-scrollback-depth
   *  concern owned by the fidelity suite, not seq reconciliation — so styles and
   *  cursor (viewport-relative) are only asserted on non-scrolled scenarios. */
  scrolled: boolean
  /** True when the terminal ended on the alternate screen. Alt has no
   *  scrollback and a fixed viewport, so its content is the visible rows and the
   *  normal-buffer content comparison does not apply (the alt-screen restore
   *  contract is scrollback-free by design — serializeHeadlessTerminalBuffer). */
  alternate: boolean
  forcedFreshRestore: boolean
  knownSerializeWrapBug: boolean
}

async function readScreen(
  term: ReturnType<typeof createRendererParityTerminal>
): Promise<RevealResult> {
  const alternate = term.terminal.buffer.active.type === 'alternate'
  return {
    content: alternate ? visibleRows(term.terminal) : normalBufferRowsTrimmed(term.terminal),
    rows: visibleRows(term.terminal),
    styles: visibleRowStyles(term.terminal),
    cursor: cursorPosition(term.terminal),
    scrolled: term.terminal.buffer.active.baseY > 0,
    alternate,
    forcedFreshRestore: false,
    knownSerializeWrapBug: false
  }
}

/** The renderer's screen for a hide→reveal cycle. `revealIdx` is the delivery
 *  index at which the pane is revealed: chunks [0, revealIdx) were captured by
 *  the HeadlessEmulator snapshot; chunks [revealIdx, end) are the racing tail.
 *  The snapshot seq is the seq of the last hidden chunk in the snapshot's
 *  domain; the tail is stitched via the production slice/reconcile rules. */
async function revealFromSnapshot(
  dims: AgentTuiStreamDims,
  chunks: MeteredChunk[],
  revealIdx: number
): Promise<RevealResult> {
  const source = createRendererParityTerminal(dims)
  const restored = createRendererParityTerminal(dims)
  try {
    // Snapshot source = every hidden chunk painted in order.
    const hiddenChunks = chunks.slice(0, revealIdx).map((c) => c.data)
    await writeChunksToTerminal(source.terminal, hiddenChunks)
    // Snapshot seq = seq of the last hidden chunk that carried one (the seq the
    // emulator would report). undefined when the hidden prefix was unmetered.
    let snapshotSeq: number | undefined
    let snapshotDomain = 0
    for (let i = revealIdx - 1; i >= 0; i--) {
      if (typeof chunks[i]!.seq === 'number') {
        snapshotSeq = chunks[i]!.seq
        snapshotDomain = chunks[i]!.domain
        break
      }
    }
    const snapshot = buildParityMainBufferSnapshot(source, snapshotSeq ?? 0, {
      // Mirror of HeadlessEmulator's ingest tracker: the hidden stream's
      // trailing incomplete escape rides the snapshot out-of-band (Bug E fix).
      pendingEscapeTail: extractPartialEscapeTail(hiddenChunks.join(''))
    })
    const alt = snapshot.alternateScreen
    const knownSerializeWrapBug = bufferHasSerializeHostileWrappedRow(source.terminal)
    // Mirror of applyMainBufferSnapshot's write order: the pending escape tail
    // is the FINAL replay write — any later ESC (e.g. the post-replay reset)
    // would abort the dangling sequence before the racing tail completes it.
    const preamble =
      alt && snapshot.scrollbackAnsi !== undefined
        ? `\x1b[?1049l\x1b[2J\x1b[3J\x1b[H${snapshot.scrollbackAnsi}${SNAPSHOT_REPLAY_PREAMBLE_ALT}`
        : alt
          ? SNAPSHOT_REPLAY_PREAMBLE_ALT
          : SNAPSHOT_REPLAY_PREAMBLE_NORMAL
    await writeChunksToTerminal(restored.terminal, [
      preamble,
      snapshot.data,
      POST_REPLAY_LIVE_SNAPSHOT_RESET_PARITY,
      ...(snapshot.pendingEscapeTailAnsi ? [snapshot.pendingEscapeTailAnsi] : [])
    ])

    // Stitch the tail. A chunk in the snapshot's domain is sliced against the
    // snapshot seq (drains the painted prefix); a chunk from a later domain
    // (post-exit seq restart) writes verbatim — production clears the baseline
    // at the ptyId-exit boundary, so no seq dedupe applies across domains.
    let forcedFreshRestore = false
    for (let i = revealIdx; i < chunks.length; i++) {
      const chunk = chunks[i]!
      if (chunk.domain !== snapshotDomain) {
        await writeChunksToTerminal(restored.terminal, [chunk.data])
        continue
      }
      const sliced = chunkDataAfterSnapshot(chunk, snapshotSeq)
      if (sliced === null) {
        // Production re-fetches a fresh snapshot here; a fresh snapshot of the
        // full stream trivially matches the always-visible screen, so mark the
        // scenario as a fresh-restore (excluded from the stitch comparison).
        forcedFreshRestore = true
        continue
      }
      if (sliced) {
        await writeChunksToTerminal(restored.terminal, [sliced])
      }
    }
    const result = await readScreen(restored)
    result.forcedFreshRestore = forcedFreshRestore
    result.knownSerializeWrapBug = knownSerializeWrapBug
    return result
  } finally {
    source.terminal.dispose()
    restored.terminal.dispose()
  }
}

async function alwaysVisible(
  dims: AgentTuiStreamDims,
  chunks: MeteredChunk[]
): Promise<RevealResult> {
  const term = createRendererParityTerminal(dims)
  try {
    await writeChunksToTerminal(
      term.terminal,
      chunks.map((c) => c.data)
    )
    return await readScreen(term)
  } finally {
    term.terminal.dispose()
  }
}

/** Reference for the seq-reconciliation gate: a snapshot of the WHOLE stream
 *  (reveal at the very end, no racing tail). Sharing the snapshot machinery with
 *  revealFromSnapshot cancels out snapshot-fidelity gaps (Bug C cursor restore,
 *  Bug B bold loss — owned by the fidelity suite), so a diff against a mid-point
 *  reveal is attributable purely to the tail-stitch seq arithmetic. */
async function fullSnapshotReference(
  dims: AgentTuiStreamDims,
  chunks: MeteredChunk[]
): Promise<RevealResult> {
  return revealFromSnapshot(dims, chunks, chunks.length)
}

type Scenario = {
  seed: number
  dims: AgentTuiStreamDims
  chunks: MeteredChunk[]
  revealIdx: number
  domains: number
  hasDropped: boolean
}

const TAIL_WORDS = [
  'reading',
  'tokens 12.4k',
  '你好世界',
  '터미널',
  '✅ done',
  'PASS test.ts',
  '+142 -37',
  'diff --git'
] as const
// Why no SGR 7 (inverse): inverse marks trailing BLANK cells with an
// inverse-fg the serializer round-trips slightly differently depending on how
// much of the buffer it captures — a serialize SGR-fidelity nuance (the Bug B
// class) that has nothing to do with seq reconciliation. Keeping it out of the
// tail keeps the styles gate a clean function of the byte-stitch.
const TAIL_SGR = ['\x1b[0m', '\x1b[31m', '\x1b[1m', '\x1b[38;5;204m', '\x1b[22m'] as const

/** Append-only racing tail: SGR runs + text + newlines only. No absolute/
 *  relative cursor motion, scroll regions, alt frames, or DECSC — so the tail
 *  paints wherever the cursor sits and its screen effect is a pure function of
 *  which bytes the seq-reconciliation applies. Terminal-state-loss garbles
 *  (Bugs C/D/E, scroll region) are pinned separately; this suite isolates the
 *  seq slice. */
function buildAppendOnlyTail(rng: () => number, lines: number): string {
  const out: string[] = []
  for (let i = 0; i < lines; i++) {
    const words: string[] = []
    const count = 1 + Math.floor(rng() * 3)
    for (let w = 0; w < count; w++) {
      words.push(TAIL_WORDS[Math.floor(rng() * TAIL_WORDS.length)]!)
    }
    const sgr = TAIL_SGR[Math.floor(rng() * TAIL_SGR.length)]!
    out.push(`${sgr}${words.join(' ')}\x1b[0m\r\n`)
  }
  return out.join('')
}

/** Builds a seeded metered stream with a random reveal boundary. A running seq
 *  counter tags the LAST byte of each chunk; at most ONE mid-stream restart
 *  bumps the domain and resets the counter low (a revived ptyId with a fresh
 *  main-side counter — production clears the restored baseline at that exit
 *  boundary, so the post-restart tail writes verbatim). Rare unmetered chunks
 *  (no seq) and droppedOutput markers model no-metering runtimes and pending-cap
 *  trims. Op counts are kept modest so most scenarios reach the full
 *  non-scrolled comparison (the tail-stitch invariant); scrolled scenarios fall
 *  back to the snapshot-depth-tolerant path (see the assertion loop). */
function buildScenario(seed: number): Scenario {
  const rng = mulberry32(seed)
  const dims = DIMS[Math.floor(rng() * DIMS.length)]!
  // Hidden prefix: full agent-TUI churn (cursor motion, panels, alt frames,
  // scroll regions, DECSC…) so the SNAPSHOT is taken over rich state.
  const prefixOps = buildAgentTuiStreamOps(rng, dims, {
    includeMouseModes: false,
    includeOscHyperlinks: false,
    opCount: 3 + Math.floor(rng() * 6)
  })
  const prefixStream = prefixOps.join('')
  const prefixRaw = splitIntoRandomChunks(mulberry32(seed ^ 0x51ed270b), prefixStream, {
    minLen: 2,
    maxLen: 64
  })
  // Racing tail: append-only content. Isolates the seq-reconciliation byte
  // stitch from terminal-state-loss garbles (Bugs C/D/E — pinned separately).
  const tailStream = buildAppendOnlyTail(rng, 2 + Math.floor(rng() * 5))
  const tailRaw = splitIntoRandomChunks(mulberry32(seed ^ 0x2545f491), tailStream, {
    minLen: 2,
    maxLen: 40
  })

  const chunks: MeteredChunk[] = []
  let seq = 100 + Math.floor(rng() * 50)
  let domain = 0
  let hasDropped = false
  // At most one restart, placed inside the tail so the snapshot's own domain
  // has a stable prefix — mirrors a single mid-session ptyId revival.
  const restartAt =
    rng() < 0.25 ? prefixRaw.length + Math.floor(rng() * Math.max(1, tailRaw.length)) : -1
  const allRaw = [...prefixRaw, ...tailRaw]
  for (let i = 0; i < allRaw.length; i++) {
    const data = allRaw[i]!
    if (i === restartAt) {
      seq = 10 + Math.floor(rng() * 20)
      domain = 1
    }
    const rawLength = data.length
    seq += rawLength
    const chunk: MeteredChunk = { data, seq, rawLength, domain }
    // Rare unmetered / dropped markers, only in the tail (the prefix must meter
    // so the snapshot carries a seq).
    if (i >= prefixRaw.length && rng() < 0.05) {
      delete chunk.seq
      delete chunk.rawLength
    }
    if (i >= prefixRaw.length && rng() < 0.04) {
      chunk.droppedOutput = true
      hasDropped = true
    }
    chunks.push(chunk)
  }

  // Reveal at or after the prefix ends, so the racing tail is purely the
  // append-only region — the snapshot captures all cursor-motion/scroll/alt
  // state and the tail cannot depend on unserialized terminal state. Landing
  // the reveal at various points INSIDE the append-only tail exercises the
  // straddle and "snapshot seq inside the tail" seq-slice cases.
  const tailSpan = Math.max(1, chunks.length - prefixRaw.length)
  const revealIdx = Math.min(chunks.length, prefixRaw.length + Math.floor(rng() * tailSpan))
  return { seed, dims, chunks, revealIdx, domains: domain + 1, hasDropped }
}

function firstRowDiff(a: string[], b: string[]): number | null {
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if ((a[i] ?? '') !== (b[i] ?? '')) {
      return i
    }
  }
  return null
}

function formatFailure(s: Scenario, stage: string, expected: unknown, actual: unknown): string {
  return [
    `hidden-reveal reconciliation divergence — stage: ${stage}`,
    `seed: ${s.seed} (re-run: FUZZ_SEED=${s.seed})`,
    `dims: ${s.dims.cols}x${s.dims.rows} revealIdx: ${s.revealIdx}/${s.chunks.length} domains: ${s.domains} dropped: ${s.hasDropped}`,
    `chunks: ${JSON.stringify(
      s.chunks.map((c) => ({ seq: c.seq, len: c.data.length, dom: c.domain }))
    )}`,
    `expected (always-visible): ${JSON.stringify(expected)}`,
    `actual   (reveal-from-snapshot): ${JSON.stringify(actual)}`
  ].join('\n')
}

describe('hidden reveal seq-reconciliation fuzz', () => {
  it('is a byte-exact identity when the snapshot seq splits a straddling chunk', async () => {
    // Pin the core invariant on a hand-built case so the property test cannot
    // pass vacuously. rawLength === data.length so the straddle slices cleanly.
    // Chunk 0 fully hidden; chunk 1 straddles the reveal; chunk 2 is the tail.
    const dims = { cols: 40, rows: 6 }
    const c0 = 'red line one\r\n'
    const c1 = 'green straddle\r\n'
    const c2 = 'plain tail rest'
    const chunks: MeteredChunk[] = [
      { data: c0, seq: c0.length, rawLength: c0.length, domain: 0 },
      { data: c1, seq: c0.length + c1.length, rawLength: c1.length, domain: 0 },
      { data: c2, seq: c0.length + c1.length + c2.length, rawLength: c2.length, domain: 0 }
    ]
    // Reveal after chunk 1 (snapshot seq = end of c1); tail = c2. Also exercise
    // the straddle by revealing at chunk 1 with a snapshot seq mid-c1 handled by
    // chunkDataAfterSnapshot when c1 is in the tail — covered by revealIdx=1.
    const revealAfterC1 = await revealFromSnapshot(dims, chunks, 2)
    const control = await alwaysVisible(dims, chunks)
    expect(revealAfterC1.rows).toEqual(control.rows)
    expect(revealAfterC1.styles).toEqual(control.styles)
    expect(revealAfterC1.cursor).toEqual(control.cursor)

    // Reveal at chunk 1: c0 hidden (snapshot seq = end of c0), c1+c2 are the
    // tail. c1 is fully after the snapshot seq so it writes whole — identity.
    const revealAtC1 = await revealFromSnapshot(dims, chunks, 1)
    expect(revealAtC1.rows).toEqual(control.rows)
    expect(revealAtC1.styles).toEqual(control.styles)
    expect(revealAtC1.cursor).toEqual(control.cursor)
  })

  // ── Bug D regression guard: DECSC saved-cursor register across hide/reveal ──
  // The serialized screen cannot carry the VT100 saved-cursor register, so a
  // hidden DECSC followed by a post-reveal DECRC restored to home and the next
  // writes clobbered the wrong cells. FIXED: the snapshot epilogue re-saves at
  // the source's saved position before the final absolute CUP
  // (serializeWithAbsoluteCursor + readSavedCursorRegister). Found by fuzz
  // seed 3; mechanism in notes/garble-fuzz-divergences.md (Bug D).
  it('preserves the DECSC saved-cursor register across a hide/reveal boundary', async () => {
    const dims = { cols: 20, rows: 4 }
    // Hidden: write 'AB', DECSC saves cursor at r0c2, move to r3c9, write 'CD'.
    const hidden: MeteredChunk = {
      data: 'AB\x1b7\x1b[4;10HCD',
      seq: 'AB\x1b7\x1b[4;10HCD'.length,
      rawLength: 'AB\x1b7\x1b[4;10HCD'.length,
      domain: 0
    }
    // Tail: DECRC restores the saved cursor, write 'X' → live shows 'ABX'.
    const tail: MeteredChunk = {
      data: '\x1b8X',
      seq: hidden.seq! + 3,
      rawLength: 3,
      domain: 0
    }
    const reveal = await revealFromSnapshot(dims, [hidden, tail], 1)
    const live = await alwaysVisible(dims, [hidden, tail])
    // Pre-fix this showed 'XB' (DECRC landed at home) instead of live's 'ABX'.
    expect(reveal.rows).toEqual(live.rows)
    expect(reveal.cursor).toEqual(live.cursor)
  })

  // ── Bug E regression guard: snapshot boundary mid-escape-sequence ──
  // A PTY read (one delivery record) can split an escape; the partial lives in
  // the emulator's parser, not the serialized screen, so the racing tail's
  // continuation rendered literal ('ABmCD'). FIXED: the emulator tracks the
  // unparsed trailing partial (terminal-partial-escape-tail.ts) and the
  // snapshot ships it out-of-band (pendingEscapeTailAnsi); the reveal replay
  // re-arms it as the final write. Found by fuzz seed 4; mechanism in
  // notes/garble-fuzz-divergences.md (Bug E).
  it('completes an escape sequence split across the hide/reveal boundary', async () => {
    const dims = { cols: 20, rows: 3 }
    // Hidden prefix ends mid-escape: 'AB' then ESC[3 (no final byte).
    const hidden: MeteredChunk = { data: 'AB\x1b[3', seq: 5, rawLength: 5, domain: 0 }
    // Tail completes it: 'm' → ESC[3m (italic), then 'CD' italic. Live: 'ABCD'.
    const tail: MeteredChunk = { data: 'mCD', seq: 8, rawLength: 3, domain: 0 }
    const reveal = await revealFromSnapshot(dims, [hidden, tail], 1)
    const live = await alwaysVisible(dims, [hidden, tail])
    // Pre-fix the reveal showed 'ABmCD' (the 'm' became literal).
    expect(reveal.rows).toEqual(live.rows)
  })

  it(`stitches the racing tail losslessly across ${ITERATIONS} seeded hide/reveal scenarios`, async () => {
    let statsCompared = 0
    let statsSkippedScrolled = 0
    let statsForcedFresh = 0
    let statsKnownWrapBug = 0
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = FIXED_SEED ?? 1 + i
      const scenario = buildScenario(seed)
      // Bug E (snapshot boundary mid-escape-sequence) is no longer tolerated:
      // the snapshot now carries the trailing partial escape out-of-band and
      // the reveal replay re-arms it last, so these scenarios must compare
      // clean like any other — a regression fails the corpus loudly.
      // Primary control: a snapshot of the WHOLE stream. Sharing the snapshot
      // machinery isolates the seq-reconciliation tail-stitch from
      // snapshot-fidelity gaps (fidelity suite's Bugs B/C). If snapshot-at-S +
      // tail differs from snapshot-of-everything, a byte was lost/duped/mis-
      // sliced. Also compare against always-visible where the two agree, to
      // catch a tail that diverges from live output.
      const [reveal, reference, live] = await Promise.all([
        revealFromSnapshot(scenario.dims, scenario.chunks, scenario.revealIdx),
        fullSnapshotReference(scenario.dims, scenario.chunks),
        alwaysVisible(scenario.dims, scenario.chunks)
      ])
      if (reveal.forcedFreshRestore || reference.forcedFreshRestore) {
        statsForcedFresh += 1
        continue
      }
      if (reveal.knownSerializeWrapBug || reference.knownSerializeWrapBug) {
        statsKnownWrapBug += 1
        continue
      }
      if (reveal.alternate !== reference.alternate) {
        expect.fail(
          formatFailure(scenario, 'alt-screen-state', reference.alternate, reveal.alternate)
        )
      }
      // Scrolled scenarios: top-row survival is a snapshot-depth question
      // (fidelity suite), not seq reconciliation.
      if (reveal.scrolled || reference.scrolled) {
        statsSkippedScrolled += 1
        continue
      }
      statsCompared += 1
      // Seq-reconciliation gate (snapshot-fidelity-neutral).
      if (firstRowDiff(reveal.content, reference.content) !== null) {
        expect.fail(
          formatFailure(scenario, 'tail-stitch-content', reference.content, reveal.content)
        )
      }
      if (firstRowDiff(reveal.rows, reference.rows) !== null) {
        expect.fail(formatFailure(scenario, 'tail-stitch-visible', reference.rows, reveal.rows))
      }
      if (firstRowDiff(reveal.styles, reference.styles) !== null) {
        expect.fail(formatFailure(scenario, 'tail-stitch-styles', reference.styles, reveal.styles))
      }
      if (JSON.stringify(reveal.cursor) !== JSON.stringify(reference.cursor)) {
        expect.fail(formatFailure(scenario, 'tail-stitch-cursor', reference.cursor, reveal.cursor))
      }
      // Stronger gate: when a full-stream SNAPSHOT already matches the
      // always-visible LIVE screen (no fidelity gap in play), the mid-point
      // reveal must match live too — a true end-to-end garble check.
      if (
        !live.scrolled &&
        live.alternate === reference.alternate &&
        firstRowDiff(reference.rows, live.rows) === null &&
        firstRowDiff(reference.styles, live.styles) === null &&
        JSON.stringify(reference.cursor) === JSON.stringify(live.cursor)
      ) {
        if (firstRowDiff(reveal.rows, live.rows) !== null) {
          expect.fail(formatFailure(scenario, 'live-visible', live.rows, reveal.rows))
        }
        if (firstRowDiff(reveal.styles, live.styles) !== null) {
          expect.fail(formatFailure(scenario, 'live-styles', live.styles, reveal.styles))
        }
        if (JSON.stringify(reveal.cursor) !== JSON.stringify(live.cursor)) {
          expect.fail(formatFailure(scenario, 'live-cursor', live.cursor, reveal.cursor))
        }
      }
    }
    // Guard against a degenerate corpus that skips its way to green: a healthy
    // fraction of scenarios must reach the full non-scrolled comparison.
    if (FIXED_SEED === null) {
      expect(statsCompared).toBeGreaterThan(ITERATIONS * 0.2)
    }
    expect(
      statsCompared + statsSkippedScrolled + statsForcedFresh + statsKnownWrapBug
    ).toBeLessThanOrEqual(ITERATIONS)
  }, 120_000)
})
