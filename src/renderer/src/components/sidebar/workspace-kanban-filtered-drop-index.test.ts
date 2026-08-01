import { describe, expect, it } from 'vitest'
import {
  parseWorkspaceLaneFullIds,
  resolveFullLaneDropIndex,
  serializeWorkspaceLaneFullIds
} from './workspace-kanban-filtered-drop-index'

const FULL = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']

describe('resolveFullLaneDropIndex', () => {
  it('is the identity when nothing is filtered', () => {
    for (let index = 0; index <= FULL.length; index++) {
      expect(
        resolveFullLaneDropIndex({
          fullLaneIds: FULL,
          renderedIds: FULL,
          filteredDropIndex: index
        })
      ).toBe(index)
    }
  })

  it('maps the first filtered slot onto the first match position', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['h'],
        filteredDropIndex: 0
      })
    ).toBe(7)
  })

  it('maps the end of a filtered lane one past the last match', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e'],
        filteredDropIndex: 2
      })
    ).toBe(5)
  })

  it('maps a slot between two matches onto the following match', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e', 'g'],
        filteredDropIndex: 1
      })
    ).toBe(4)
  })

  it('appends into a lane whose cards are all filtered away', () => {
    // Why: an empty rendered lane reports drop index 0 for every pointer
    // position, so honouring it would always prepend. The document-drop path
    // appends for the same gesture, and these must not disagree.
    expect(
      resolveFullLaneDropIndex({ fullLaneIds: FULL, renderedIds: [], filteredDropIndex: 0 })
    ).toBe(FULL.length)
    expect(
      resolveFullLaneDropIndex({ fullLaneIds: FULL, renderedIds: [], filteredDropIndex: 3 })
    ).toBe(FULL.length)
    expect(
      resolveFullLaneDropIndex({ fullLaneIds: [], renderedIds: [], filteredDropIndex: 0 })
    ).toBe(0)
  })

  it('falls back toward the end of the lane the branch was aiming at', () => {
    // A head drop resolves to the head, not the tail — the opposite fallback
    // would land a card at the bottom of a lane the user dropped it on top of.
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['stale', 'e'],
        filteredDropIndex: 0
      })
    ).toBe(0)
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'stale'],
        filteredDropIndex: 2
      })
    ).toBe(FULL.length)
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'stale', 'g'],
        filteredDropIndex: 1
      })
    ).toBe(FULL.length)
  })

  it('still translates when a stale lane has the same length but different members', () => {
    // Why: a length-only guard would take the identity branch here and skip
    // translation, landing the card at an index that means nothing in FULL.
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: ['a', 'b', 'c'],
        renderedIds: ['a', 'x', 'c'],
        filteredDropIndex: 1
      })
    ).toBe(3)
  })

  it('clamps out-of-range filtered indices to the first and last branches', () => {
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e'],
        filteredDropIndex: -3
      })
    ).toBe(1)
    expect(
      resolveFullLaneDropIndex({
        fullLaneIds: FULL,
        renderedIds: ['b', 'e'],
        filteredDropIndex: 99
      })
    ).toBe(5)
  })
})

describe('workspace lane full-id channel', () => {
  it('round-trips lane membership through the delimiter', () => {
    const ids = ['repo-a::/Users/dev/projects/orca/main', 'repo-b::C:\\src\\atlas, v2']
    const serialized = serializeWorkspaceLaneFullIds(ids)

    expect(serialized).not.toBeNull()
    expect(parseWorkspaceLaneFullIds(serialized ?? undefined)).toEqual(ids)
  })

  it('distinguishes an unpublished lane from an empty one', () => {
    expect(parseWorkspaceLaneFullIds(undefined)).toBeNull()
    expect(parseWorkspaceLaneFullIds('')).toEqual([])
    expect(serializeWorkspaceLaneFullIds([])).toBe('')
  })

  it('survives ids holding every character a path can legally contain', () => {
    // Why: a POSIX path may hold any byte but NUL and '/', so a newline, comma
    // or colon delimiter would split one id into phantom lane members. Dropping
    // the channel is not an escape hatch either — under a query the reader
    // would fall back to the DOM and see only the matched cards.
    const ids = ['repo-a::/Users/dev/we\nird, one: two', 'repo-b::C:\\src\\atlas']

    expect(parseWorkspaceLaneFullIds(serializeWorkspaceLaneFullIds(ids) ?? undefined)).toEqual(ids)
  })
})
