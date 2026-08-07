import { describe, expect, it } from 'vitest'
import {
  buildAgentTuiStreamOps,
  mulberry32,
  splitIntoRandomChunks
} from './agent-tui-ansi-fuzz-stream'
import { TerminalModeStateTracker } from './terminal-mode-state-tracker'
import { parseTerminalModes, resolveReplayRestoredModes } from './terminal-reattach-mode-restore'
import type { TerminalModes } from './terminal-modes'

// Property under test: seeding a tracker with the modes tracked up to an attach
// boundary and scanning the replay suffix must land on the same modes as
// tracking the whole stream — the exact merge resolveReplayRestoredModes
// performs when a relay replay tail is painted over a mode seed.
//
// Runtime knobs mirror headless-emulator-fidelity.fuzz.test.ts:
//   FUZZ_ITERATIONS=5000  deep mode (default 500)
//   FUZZ_SEED=1234        re-run exactly one seed

const DEFAULT_ITERATIONS = 500
const FIXED_SEED = readPositiveIntEnv('FUZZ_SEED')
const ITERATIONS =
  FIXED_SEED !== null ? 1 : (readPositiveIntEnv('FUZZ_ITERATIONS') ?? DEFAULT_ITERATIONS)

function readPositiveIntEnv(name: string): number | null {
  const raw = Number(process.env[name])
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : null
}

function trackStream(chunks: readonly string[]): TerminalModes {
  const tracker = new TerminalModeStateTracker()
  for (const chunk of chunks) {
    tracker.scan(chunk)
  }
  return tracker.getModes()
}

describe('resolveReplayRestoredModes', () => {
  it(`merge(track(prefix), suffix) === track(full) across ${ITERATIONS} seeded agent-TUI streams`, () => {
    for (let i = 0; i < ITERATIONS; i++) {
      const seed = FIXED_SEED ?? 1 + i
      const rng = mulberry32(seed)
      const opCount = 8 + Math.floor(rng() * 24)
      const ops = buildAgentTuiStreamOps(
        rng,
        { cols: 100, rows: 30 },
        { includeMouseModes: true, includeOscHyperlinks: false, opCount }
      )
      // Split at an op boundary: the attach boundary always falls between
      // complete PTY writes; chunking WITHIN each side still splits escape
      // sequences arbitrarily, which the tracker must reassemble.
      const splitOpIndex = Math.floor(rng() * (ops.length + 1))
      const prefix = ops.slice(0, splitOpIndex).join('')
      const suffix = ops.slice(splitOpIndex).join('')
      const prefixChunks = splitIntoRandomChunks(mulberry32(seed ^ 0x9e3779b9), prefix, {
        minLen: 3,
        maxLen: 80
      })
      const seedModes = trackStream(prefixChunks)
      const merged = resolveReplayRestoredModes({ seedModes, replayData: suffix })
      const expected = trackStream([prefix + suffix])
      expect(
        merged,
        `seed ${seed} split ${splitOpIndex}/${ops.length} (re-run: FUZZ_SEED=${seed})`
      ).toEqual(expected)
    }
  })

  it('returns null without seed modes so callers keep the legacy byte-inference', () => {
    expect(resolveReplayRestoredModes({ seedModes: undefined, replayData: '\x1b[?1049h' })).toBe(
      null
    )
    expect(resolveReplayRestoredModes({ seedModes: null, replayData: '\x1b[?1049h' })).toBe(null)
  })

  it('returns the seed advanced by the replay tail', () => {
    const merged = resolveReplayRestoredModes({
      seedModes: {
        bracketedPaste: true,
        mouseTracking: true,
        mouseTrackingMode: 'drag',
        sgrMouseMode: true,
        applicationCursor: false,
        alternateScreen: true
      },
      replayData: 'tui frame\x1b[?1049l'
    })
    expect(merged).toMatchObject({
      alternateScreen: false,
      bracketedPaste: true,
      mouseTracking: true,
      mouseTrackingMode: 'drag',
      sgrMouseMode: true,
      kittyKeyboardFlags: 0
    })
  })
})

describe('parseTerminalModes', () => {
  const validModes = {
    bracketedPaste: true,
    mouseTracking: true,
    mouseTrackingMode: 'drag',
    sgrMouseMode: true,
    sgrMousePixelsMode: false,
    applicationCursor: false,
    alternateScreen: true,
    kittyKeyboardFlags: 5
  }

  it('accepts a fully populated shape', () => {
    expect(parseTerminalModes(validModes)).toEqual(validModes)
  })

  it('accepts the minimal required shape', () => {
    const minimal = {
      bracketedPaste: false,
      mouseTracking: false,
      applicationCursor: false,
      alternateScreen: false
    }
    expect(parseTerminalModes(minimal)).toEqual(minimal)
  })

  it('rejects malformed shapes without throwing', () => {
    expect(parseTerminalModes(undefined)).toBeUndefined()
    expect(parseTerminalModes(null)).toBeUndefined()
    expect(parseTerminalModes('modes')).toBeUndefined()
    expect(parseTerminalModes([])).toBeUndefined()
    expect(parseTerminalModes({})).toBeUndefined()
    expect(parseTerminalModes({ ...validModes, bracketedPaste: 'yes' })).toBeUndefined()
    expect(parseTerminalModes({ ...validModes, mouseTrackingMode: 'laser' })).toBeUndefined()
    expect(parseTerminalModes({ ...validModes, sgrMouseMode: 1 })).toBeUndefined()
    expect(parseTerminalModes({ ...validModes, kittyKeyboardFlags: -1 })).toBeUndefined()
    expect(parseTerminalModes({ ...validModes, kittyKeyboardFlags: 1.5 })).toBeUndefined()
    expect(parseTerminalModes({ ...validModes, alternateScreen: undefined })).toBeUndefined()
  })
})
