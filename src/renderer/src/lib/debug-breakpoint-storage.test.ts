import { describe, expect, it, vi } from 'vitest'
import type { Breakpoint } from '../../../shared/debug-breakpoint-types'
import {
  DEBUG_BREAKPOINTS_STORAGE_KEY,
  normalizeBreakpointsByPath,
  readDebugBreakpoints,
  writeDebugBreakpoints
} from './debug-breakpoint-storage'

const bp: Breakpoint = { id: '1', path: '/a.ts', line: 3, verified: false }

describe('normalizeBreakpointsByPath', () => {
  it('drops non-object input', () => {
    expect(normalizeBreakpointsByPath(null)).toEqual({})
    expect(normalizeBreakpointsByPath('nope')).toEqual({})
  })

  it('drops entries whose value is not an array', () => {
    expect(normalizeBreakpointsByPath({ '/a.ts': 'nope' })).toEqual({})
  })

  it('drops malformed breakpoints and paths left with none', () => {
    expect(
      normalizeBreakpointsByPath({
        '/a.ts': [{ id: '1' }, { id: '2', path: '/a.ts', line: 0, verified: false }]
      })
    ).toEqual({})
  })

  it('drops a breakpoint whose stamped path does not match its key', () => {
    expect(normalizeBreakpointsByPath({ '/a.ts': [{ ...bp, path: '/b.ts' }] })).toEqual({})
  })

  it('keeps valid breakpoints', () => {
    expect(normalizeBreakpointsByPath({ '/a.ts': [bp] })).toEqual({ '/a.ts': [bp] })
  })
})

describe('readDebugBreakpoints / writeDebugBreakpoints', () => {
  it('returns empty when storage is unavailable or empty', () => {
    expect(readDebugBreakpoints(null)).toEqual({})
    const storage = { getItem: vi.fn(() => null), setItem: vi.fn() }
    expect(readDebugBreakpoints(storage)).toEqual({})
  })

  it('falls back safely on malformed JSON', () => {
    const storage = { getItem: vi.fn(() => '{not-json'), setItem: vi.fn() }
    expect(readDebugBreakpoints(storage)).toEqual({})
  })

  it('round-trips through write then read', () => {
    let stored: string | null = null
    const storage = {
      getItem: vi.fn(() => stored),
      setItem: vi.fn((_key: string, value: string) => {
        stored = value
      })
    }

    expect(writeDebugBreakpoints({ '/a.ts': [bp] }, storage)).toBe(true)
    expect(storage.setItem).toHaveBeenCalledWith(
      DEBUG_BREAKPOINTS_STORAGE_KEY,
      JSON.stringify({ '/a.ts': [bp] })
    )
    expect(readDebugBreakpoints(storage)).toEqual({ '/a.ts': [bp] })
  })

  it('reports failed writes without throwing', () => {
    const storage = {
      getItem: vi.fn(() => null),
      setItem: vi.fn(() => {
        throw new Error('quota exceeded')
      })
    }
    expect(writeDebugBreakpoints({ '/a.ts': [bp] }, storage)).toBe(false)
  })
})
