import { describe, expect, it } from 'vitest'
import type { Breakpoint } from '../../../../shared/debug-breakpoint-types'
import {
  buildBreakpointDecorations,
  buildBreakpointHintDecoration,
  getBreakpointGlyphClassName,
  getBreakpointHoverMessage
} from './monaco-breakpoint-decorations'

const plain: Breakpoint = { id: '1', path: '/a.ts', line: 5, verified: true }
const conditional: Breakpoint = { ...plain, id: '2', condition: 'i === 10' }
const logpoint: Breakpoint = { ...plain, id: '3', logMessage: 'hit {i}' }
const both: Breakpoint = { ...plain, id: '4', condition: 'i > 1', logMessage: 'hit {i}' }

describe('getBreakpointGlyphClassName', () => {
  it('renders a plain verified breakpoint', () => {
    expect(getBreakpointGlyphClassName(plain)).toBe('orca-breakpoint-glyph')
  })

  it('renders a conditional breakpoint', () => {
    expect(getBreakpointGlyphClassName(conditional)).toBe(
      'orca-breakpoint-glyph orca-breakpoint-glyph--conditional'
    )
  })

  it('renders a logpoint', () => {
    expect(getBreakpointGlyphClassName(logpoint)).toBe(
      'orca-breakpoint-glyph orca-breakpoint-glyph--logpoint'
    )
  })

  it('a log message wins over a condition when both are set', () => {
    expect(getBreakpointGlyphClassName(both)).toBe(
      'orca-breakpoint-glyph orca-breakpoint-glyph--logpoint'
    )
  })

  it('appends the unverified modifier', () => {
    expect(getBreakpointGlyphClassName({ ...plain, verified: false })).toBe(
      'orca-breakpoint-glyph orca-breakpoint-glyph--unverified'
    )
    expect(getBreakpointGlyphClassName({ ...conditional, verified: false })).toBe(
      'orca-breakpoint-glyph orca-breakpoint-glyph--conditional orca-breakpoint-glyph--unverified'
    )
  })
})

describe('getBreakpointHoverMessage', () => {
  it('describes a plain breakpoint', () => {
    expect(getBreakpointHoverMessage(plain)).toBe('Breakpoint')
  })

  it('lists condition, hit count, log message, and unverified state', () => {
    const bp: Breakpoint = { ...plain, verified: false, condition: 'x', hitCondition: '>5', logMessage: 'm' }
    expect(getBreakpointHoverMessage(bp)).toBe(
      'Log message: m\nCondition: x\nHit count: >5\nUnverified — will resolve once a debug session starts'
    )
  })
})

describe('buildBreakpointDecorations', () => {
  it('places a lines-decoration at each breakpoint line', () => {
    expect(buildBreakpointDecorations([plain])).toEqual([
      {
        range: { startLineNumber: 5, startColumn: 1, endLineNumber: 5, endColumn: 1 },
        options: {
          linesDecorationsClassName: 'orca-breakpoint-glyph',
          linesDecorationsTooltip: 'Breakpoint'
        }
      }
    ])
  })

  it('returns one decoration per breakpoint, in order', () => {
    expect(buildBreakpointDecorations([plain, conditional])).toHaveLength(2)
  })
})

describe('buildBreakpointHintDecoration', () => {
  it('places a hint-styled decoration at the given line', () => {
    expect(buildBreakpointHintDecoration(7)).toEqual({
      range: { startLineNumber: 7, startColumn: 1, endLineNumber: 7, endColumn: 1 },
      options: { linesDecorationsClassName: 'orca-breakpoint-glyph orca-breakpoint-glyph--hint' }
    })
  })
})
