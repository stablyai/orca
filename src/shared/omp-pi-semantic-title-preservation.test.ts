/** OMP/Pi titles use π, never OMP/Pi. Verified oh-my-pi utils/title-generator.ts DEFAULT_TERMINAL_TITLE/buildTerminalTitleWithState
 * (native π frame label); Orca’s injected pi/titlebar-extension-source.ts instead emits π - session - cwd with 80ms braille frames.
 * Orca manufactured OMP/Pi flicker via synthetic profile labels and normalization that discarded session/cwd (#16093).
 * OMP disables terminal-title synthesis so its session titles survive every state. Normalize rotating braille while preserving labels. */
import { describe, expect, it } from 'vitest'
import {
  detectAgentStatusFromTitle,
  normalizeTerminalTitle
} from './agent-status/title/agent-title-status'
import { normalizeCompatibleAgentTitleForOwner } from './agent-status/title/agent-title-owner'
import { getPiCompatibleTitleSeparatorStatus } from './agent-status/title/providers/pi-compatible-synthetic-title'

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
})
