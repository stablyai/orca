import { describe, expect, it } from 'vitest'
import {
  SIDEBAR_BOTS_MIN_HEIGHT,
  SIDEBAR_PROJECTS_MIN_LIST_HEIGHT,
  computeSidebarBotsMaxHeight,
  normalizeSidebarBotsHeight
} from './sidebar-bots-height'

describe('normalizeSidebarBotsHeight', () => {
  it.each([undefined, null, 'x', Number.NaN, Infinity, 0, -5])('keeps the default for %s', (v) => {
    expect(normalizeSidebarBotsHeight(v)).toBeNull()
  })

  it('rounds and floors a saved height at the Bots minimum', () => {
    expect(normalizeSidebarBotsHeight(250.6)).toBe(251)
    expect(normalizeSidebarBotsHeight(10)).toBe(SIDEBAR_BOTS_MIN_HEIGHT)
  })
})

describe('computeSidebarBotsMaxHeight', () => {
  it('gives Bots what the Projects list holds above its minimum', () => {
    expect(computeSidebarBotsMaxHeight(200, 400)).toBe(600 - SIDEBAR_PROJECTS_MIN_LIST_HEIGHT)
  })

  it('never drops below the Bots minimum when Projects is already squeezed', () => {
    expect(computeSidebarBotsMaxHeight(60, 0)).toBe(SIDEBAR_BOTS_MIN_HEIGHT)
  })
})
