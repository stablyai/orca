/** OMP/Pi titles use π, never OMP/Pi. Verified oh-my-pi utils/title-generator.ts DEFAULT_TERMINAL_TITLE/buildTerminalTitleWithState
 * (native π frame label); Orca’s injected pi/titlebar-extension-source.ts instead emits π - session - cwd with 80ms braille frames.
 * Orca manufactured OMP/Pi flicker via synthetic profile labels and normalization that discarded session/cwd (#16093).
 * OMP disables terminal-title synthesis so its session titles survive every state. Normalize rotating braille while preserving labels. */
import { describe, expect, it } from 'vitest'
import { detectAgentStatusFromTitle, normalizeTerminalTitle } from './agent-title-status'
import { isDecorativeAgentTitleFrameChange } from './agent-decorative-title-signature'
import { normalizeCompatibleAgentTitleForOwner } from './agent-title-owner'
import { getPiCompatibleTitleSeparatorStatus } from './pi-compatible-synthetic-title'

// Verbatim from src/main/pi/titlebar-extension-source.ts:44 and oh-my-pi:530-544.
const ORCA_EXTENSION_WORKING = (frame: string): string => `${frame} π - fixing the sidebar - orca`
const OMP_NATIVE_WORKING = (frame: string): string => `π ${frame} fixing the sidebar`
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

describe('normalizeTerminalTitle keeps the OMP/Pi session label', () => {
  it.each([
    ['Orca extension (spinner leads)', ORCA_EXTENSION_WORKING],
    ['OMP native (spinner is medial)', OMP_NATIVE_WORKING]
  ])('collapses every %s frame to one value without losing the label', (_name, build) => {
    const normalized = new Set(FRAMES.map((frame) => normalizeTerminalTitle(build(frame))))

    expect(normalized.size).toBe(1)
    const [only] = [...normalized]
    expect(only).toContain('fixing the sidebar')
    expect(only).toContain('π')
    // The bare labels the old collapse minted must be gone entirely.
    expect(only).not.toBe('⠋ Pi')
    expect(only).not.toBe('Pi')
  })

  it('leaves idle and attention titles byte-identical', () => {
    for (const title of [
      'π - fixing the sidebar - orca',
      'π > fixing the sidebar',
      'π ! fixing the sidebar',
      'π: fixing the sidebar'
    ]) {
      expect(normalizeTerminalTitle(title)).toBe(title)
    }
  })

  // Multiplexer prefixes defeated anchored frame collapse and propagated churn (#8032).
  it('collapses frames under a multiplexer prefix', () => {
    const normalized = new Set(
      FRAMES.map((frame) => normalizeTerminalTitle(`zsh | ${ORCA_EXTENSION_WORKING(frame)}`))
    )

    expect(normalized.size).toBe(1)
    expect([...normalized][0]).toContain('fixing the sidebar')
  })

  it('keeps two different sessions distinguishable', () => {
    expect(normalizeTerminalTitle('π - session A - orca')).not.toBe(
      normalizeTerminalTitle('π - session B - orca')
    )
  })
})

describe('detectAgentStatusFromTitle reads the π state separator', () => {
  it.each([
    ['π ! fixing the sidebar', 'permission'],
    ['π > fixing the sidebar', 'idle'],
    ['π ⠋ fixing the sidebar', 'working'],
    ['⠋ π - fixing the sidebar - orca', 'working'],
    ['π: fixing the sidebar', 'idle'],
    // Session names are free text; only the synthetic label means permission.
    ['π - fix action required banner - orca', 'idle'],
    ['OMP - fix action required banner - orca', 'idle']
  ])('classifies %s as %s', (title, expected) => {
    expect(detectAgentStatusFromTitle(title)).toBe(expected)
  })
})

describe('the churn is gone at the suppressor', () => {
  it('treats consecutive animation frames as decoration', () => {
    for (const build of [ORCA_EXTENSION_WORKING, OMP_NATIVE_WORKING]) {
      for (let index = 1; index < FRAMES.length; index += 1) {
        expect(
          isDecorativeAgentTitleFrameChange(
            normalizeTerminalTitle(build(FRAMES[index - 1])),
            normalizeTerminalTitle(build(FRAMES[index]))
          )
        ).toBe(true)
      }
    }
  })

  it('still commits a real working -> attention transition', () => {
    expect(
      isDecorativeAgentTitleFrameChange(
        normalizeTerminalTitle(ORCA_EXTENSION_WORKING('⠋')),
        normalizeTerminalTitle('π ! fixing the sidebar')
      )
    ).toBe(false)
  })
})

describe('the owner relabel keeps the label and swaps only the brand', () => {
  // Rewrite only brand across pane/tab/sidebar/mobile displays: preserve session text (#16093) and explicit owner identity (#6689/#7633/#9077).
  it.each([
    ['⠋ π - fixing the sidebar - orca', '⠋ OMP - fixing the sidebar - orca'],
    ['π - fixing the sidebar - orca', 'OMP - fixing the sidebar - orca'],
    ['π ! fixing the sidebar', 'OMP ! fixing the sidebar'],
    ['π > fixing the sidebar', 'OMP > fixing the sidebar']
  ])('rewrites %s to %s for an omp-owned pane', (title, expected) => {
    expect(normalizeCompatibleAgentTitleForOwner(title, 'omp')).toBe(expected)
  })

  // Owner-rewritten titles feed classification; preserve the source’s status through that round trip.
  it.each([
    '⠋ π - fixing the sidebar - orca',
    'π - fixing the sidebar - orca',
    'π ! fixing the sidebar',
    'π > fixing the sidebar',
    '⠋ Pi',
    'Pi ready',
    'Pi - action required'
  ])('preserves the status of %s across the owner rewrite', (title) => {
    expect(detectAgentStatusFromTitle(normalizeCompatibleAgentTitleForOwner(title, 'omp'))).toBe(
      detectAgentStatusFromTitle(title)
    )
  })

  // Persisted bare frames lack session text but still need explicit OMP owner identity (#6689/#7633/#9077).
  it('still re-owns bare identity frames', () => {
    expect(normalizeCompatibleAgentTitleForOwner('⠋ Pi', 'omp')).toBe('⠋ OMP')
    expect(normalizeCompatibleAgentTitleForOwner('Pi ready', 'omp')).toBe('OMP ready')
    expect(normalizeCompatibleAgentTitleForOwner('⠋ OMP', 'pi')).toBe('⠋ Pi')
  })
})

describe('the state separator does not fire on ordinary titles', () => {
  // Exact profile casing distinguishes rewritten state separators from ordinary omp-harness/pi task names.
  it.each([
    'omp-harness ready',
    'pi-scratch ready',
    'pipeline - build',
    'pip - install',
    'pi - refactor the parser',
    'omp - deploy notes',
    'npm - run build',
    'node - server'
  ])('classifies %s as no agent', (title) => {
    expect(detectAgentStatusFromTitle(title)).toBeNull()
  })
})

describe('latent hazards the reviewers flagged', () => {
  // Hyphen also separates permission labels; synthetic classification must run first. Pin caller and exported separator behavior.
  it.each(['Pi - action required', 'OMP - action required'])(
    'classifies %s as permission, not idle',
    (title) => {
      expect(detectAgentStatusFromTitle(title)).toBe('permission')
      expect(getPiCompatibleTitleSeparatorStatus(title)).toBe('permission')
    }
  )

  // Hydration reprocesses rewritten titles; preserve the fixed point so future omp/pi tokenization cannot erase session text.
  it.each([
    '⠋ π - fixing the sidebar - orca',
    'π - fixing the sidebar - orca',
    'π ! fixing the sidebar',
    'π ⠙ fixing the sidebar',
    'zsh | ⠙ π - a - b'
  ])('is a fixed point when the owner rewrite re-runs on %s', (title) => {
    const once = normalizeCompatibleAgentTitleForOwner(title, 'omp')
    expect(normalizeCompatibleAgentTitleForOwner(once, 'omp')).toBe(once)
    expect(once).toContain('OMP')
  })
})
