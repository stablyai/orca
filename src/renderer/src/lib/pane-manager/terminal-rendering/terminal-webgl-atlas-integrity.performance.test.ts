import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  atlas,
  blank,
  evict,
  fakePane,
  fakeReader,
  glyph,
  ink,
  setupAtlasIntegrityFixture
} from './terminal-webgl-atlas-integrity-test-fixture'
import { createGlyphInkReader } from './terminal-webgl-atlas-ink-reader'
import { fakeKit, pageWithInk } from './terminal-webgl-atlas-test-canvas'
import { verifyPaneWebglAtlasIntegrity } from './terminal-webgl-atlas-integrity'
import { checkAtlasIntegrity, type GlyphInkReader } from './terminal-webgl-atlas-sampling'

// STA-17523: recovery for missing terminal glyphs must bound readbacks, clears and repeated root scans.
const fixture = setupAtlasIntegrityFixture()
const { advanceServiceClock, deps, events, register, takeScheduledWake } = fixture
const traversal = () => ({ layoutVersion: undefined, cursors: [], startPage: 0 })

function lateControlFailure(availableCredits: number) {
  const prepareControl = vi.fn().mockImplementationOnce(() => {
    throw new Error('source control copy failed')
  })
  const brokenKit = fakeKit({ beforeSourceControl: prepareControl })
  const replacementKit = fakeKit()
  const brokenCopies = vi.spyOn(brokenKit.ctx, 'drawImage')
  const brokenReadback = vi.spyOn(brokenKit.ctx, 'getImageData')
  const replacementCopies = vi.spyOn(replacementKit.ctx, 'drawImage')
  const replacementReadback = vi.spyOn(replacementKit.ctx, 'getImageData')
  const kits = [brokenKit, replacementKit]
  const sharedDeps = deps(createGlyphInkReader(() => kits.shift() ?? null))
  const firstCanvas = pageWithInk(true)
  const laterCanvas = pageWithInk(false)
  const sharedAtlas = atlas()
  sharedAtlas.pages[0].canvas = firstCanvas
  sharedAtlas.pages.push({ canvas: laterCanvas, glyphs: [glyph(0)] })
  const affected = fakePane(sharedAtlas)
  const unrelatedAtlas = atlas()
  const unrelatedCanvas = unrelatedAtlas.pages[0].canvas
  const unrelated = fakePane(unrelatedAtlas)
  register(true, [affected, unrelated])
  fixture.state.readTimes.push(
    ...Array.from({ length: 16 - availableCredits }, () => fixture.clock)
  )

  verifyPaneWebglAtlasIntegrity(affected, 'reveal', sharedDeps)
  expect(prepareControl).toHaveBeenCalledTimes(1)
  expect(brokenCopies.mock.calls.map(([source]) => source)).toEqual([
    firstCanvas,
    brokenKit.control
  ])
  expect(brokenReadback).not.toHaveBeenCalled()

  return {
    affected,
    laterCanvas,
    replacementKit,
    replacementCopies,
    replacementReadback,
    sharedDeps,
    unrelated,
    unrelatedCanvas
  }
}

describe('terminal WebGL atlas work limits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
  })

  it('counts unreadable and throwing reads and respects the read budget', () => {
    const throwing: GlyphInkReader = (_canvas, _rect, onReadIssued) => {
      onReadIssued()
      throw new Error('readback failed')
    }
    expect(checkAtlasIntegrity(atlas(), throwing, traversal(), 16)).toEqual({
      outcome: 'inconclusive',
      reads: 1
    })
    expect(checkAtlasIntegrity(atlas(), blank, traversal(), 0)).toEqual({
      outcome: 'inconclusive',
      reads: 0
    })
  })

  it('stops after two unreadable candidates even with credit for a later blank', () => {
    const shared = atlas()
    shared.pages.push(...atlas().pages, ...atlas([glyph(0)], 1024).pages)
    const reader = vi.fn(fakeReader((canvas) => (canvas.width === 512 ? 'unreadable' : 'blank')))

    expect(checkAtlasIntegrity(shared, reader, traversal(), 16)).toEqual({
      outcome: 'inconclusive',
      reads: 2
    })
    expect(reader).toHaveBeenCalledTimes(2)
  })

  it('refuses resets past the per-atlas cap and charges failed clears', () => {
    const pane = fakePane(atlas())
    pane.addon.clearTextureAtlas.mockImplementation(() => {})
    register(true, [pane])
    for (let attempt = 0; attempt < 5; attempt++) {
      fixture.clock += 61_000
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
    }
    expect(pane.addon.clearTextureAtlas).toHaveBeenCalledTimes(3)
    expect(events.map((event) => event.outcome)).toEqual([
      'reset-failed',
      'reset-failed',
      'reset-failed',
      'refused',
      'refused'
    ])
  })

  it('does no owner discovery while the renderer-wide gate still denies the service', () => {
    const paneAtlas = atlas()
    const pane = fakePane(paneAtlas)
    const manager = register(true, [pane])
    const forEach = vi.spyOn(manager, 'forEachInternalPane')

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
    forEach.mockClear()
    // Fire early: the gate still denies, so the service re-arms without scanning.
    const early = fixture.timers.shift()
    early?.callback()

    expect(forEach).not.toHaveBeenCalled()
    expect(fixture.timers).toHaveLength(1)
  })

  it('keeps at most eight pending atlases, dropping the oldest', () => {
    const first = fakePane(atlas())
    register(true, [first])
    verifyPaneWebglAtlasIntegrity(first, 'reveal', deps(ink))
    const waitingAtlases = Array.from({ length: 9 }, () => atlas())
    const waiting = waitingAtlases.map((paneAtlas) => fakePane(paneAtlas))
    register(true, waiting)
    for (const pane of waiting) {
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(ink))
    }

    expect(fixture.state.pending.size).toBe(8)
    expect([...fixture.state.pending.keys()].some((ref) => ref.deref() === waitingAtlases[0])).toBe(
      false
    )
    expect(fixture.timers).toHaveLength(1)
  })

  it('does not charge the read budget when no scratch could be created', () => {
    const pane = fakePane(atlas())
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(
      pane,
      'reveal',
      deps(() => 'unavailable')
    )

    expect(fixture.state.readTimes).toEqual([])
    expect(fixture.state.lastAttemptAt).toBe(fixture.clock)
  })

  it('holds the rolling budget until the oldest physical readback expires', () => {
    const start = fixture.clock
    const readTimes: number[] = []
    const kit = fakeKit()
    const clearRect = kit.ctx.clearRect.bind(kit.ctx)
    vi.spyOn(kit.ctx, 'clearRect').mockImplementation((...args) => {
      if (readTimes.length === 0) {
        advanceServiceClock(4)
      }
      clearRect(...args)
    })
    const getImageData = kit.ctx.getImageData.bind(kit.ctx)
    vi.spyOn(kit.ctx, 'getImageData').mockImplementation((...args) => {
      readTimes.push(fixture.clock)
      const pixels = getImageData(...args)
      if (readTimes.length === 1) {
        advanceServiceClock(3)
      }
      return pixels
    })
    const sharedDeps = deps(createGlyphInkReader(() => kit))
    const atlases = Array.from({ length: 17 }, () => {
      const paneAtlas = atlas()
      paneAtlas.pages[0].canvas = pageWithInk(true)
      return paneAtlas
    })
    const panes = atlases.map((paneAtlas) => fakePane(paneAtlas))
    register(true, panes)

    verifyPaneWebglAtlasIntegrity(panes[0], 'reveal', sharedDeps)
    expect(readTimes).toEqual([start + 4])
    expect(fixture.state.lastAttemptAt).toBe(start)
    expect(fixture.state.atlases.get(atlases[0])?.completedAt).toBe(start + 7)
    for (const [index, pane] of panes.slice(1, 16).entries()) {
      advanceServiceClock(start + (index + 1) * 50 - fixture.clock)
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', sharedDeps)
    }
    expect(readTimes).toHaveLength(16)

    advanceServiceClock(start + 1001 - fixture.clock)
    verifyPaneWebglAtlasIntegrity(panes[16], 'reveal', sharedDeps)
    expect(readTimes).toHaveLength(16)
    expect(fixture.state.pending.size).toBe(1)

    const wake = takeScheduledWake(3)
    advanceServiceClock(3)
    wake()
    expect(readTimes).toHaveLength(17)
    expect(readTimes.at(-1)).toBe(start + 1004)
    expect(fixture.state.pending.size).toBe(0)
    expect(fixture.state.timerArmed).toBe(false)
  })

  it('keeps the last physical credit after a late preparation failure with one reservation', () => {
    const observation = lateControlFailure(1)
    expect(observation.replacementCopies).not.toHaveBeenCalled()
    expect(observation.replacementReadback).not.toHaveBeenCalled()
    expect(observation.affected.addon.clearTextureAtlas).not.toHaveBeenCalled()

    fixture.clock += 50
    verifyPaneWebglAtlasIntegrity(observation.unrelated, 'reveal', observation.sharedDeps)
    expect(observation.replacementCopies.mock.calls.map(([source]) => source)).toEqual([
      observation.unrelatedCanvas,
      observation.replacementKit.control
    ])
    expect(observation.replacementReadback).toHaveBeenCalledTimes(1)
    expect(observation.unrelated.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(observation.affected.addon.clearTextureAtlas).not.toHaveBeenCalled()
  })

  it('reads the next page after a late preparation failure with two reservations', () => {
    const observation = lateControlFailure(2)
    const sources = observation.replacementCopies.mock.calls.map(([source]) => source)
    expect(sources).toEqual([observation.laterCanvas, observation.replacementKit.control])
    expect(observation.replacementReadback).toHaveBeenCalledTimes(1)
    expect(observation.affected.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(observation.unrelated.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(events).toEqual([expect.objectContaining({ page: 1, outcome: 'reset' })])
  })

  it('checks each stable disjoint root once when repainting the recovered atlas', () => {
    const shared = atlas()
    const panes = Array.from({ length: 4 }, () => fakePane(shared))
    const rootChecks = panes.map((pane) => vi.spyOn(register(true, [pane]), 'containsElement'))
    panes[0].addon.clearTextureAtlas.mockImplementation(() => {
      for (const rootCheck of rootChecks) {
        rootCheck.mockClear()
      }
      evict(shared)
    })

    verifyPaneWebglAtlasIntegrity(panes[0], 'reveal', deps(blank))

    expect(events).toEqual([expect.objectContaining({ outcome: 'reset' })])
    expect(rootChecks.map((rootCheck) => rootCheck.mock.calls.length)).toEqual([1, 1, 1, 1])
    for (const pane of panes) {
      expect(pane.refresh).toHaveBeenCalledTimes(1)
    }
  })

  it.each([
    ['context loss before readback', false],
    ['an exception during preparation', false],
    ['an exception during readback', true]
  ] as const)('accounts for physical readback after %s', (failure, issued) => {
    const start = fixture.clock
    const brokenKit = fakeKit({ lost: failure === 'context loss before readback' })
    const nextKit = fakeKit()
    const firstReadback = vi.spyOn(brokenKit.ctx, 'getImageData')
    const nextReadback = vi.spyOn(nextKit.ctx, 'getImageData')
    if (failure === 'an exception during preparation') {
      vi.spyOn(brokenKit.ctx, 'clearRect').mockImplementation(() => {
        throw new Error('scratch preparation failed')
      })
    } else if (failure === 'an exception during readback') {
      firstReadback.mockImplementation(() => {
        throw new Error('readback failed')
      })
    }
    const kits = [brokenKit, nextKit]
    const sharedDeps = deps(createGlyphInkReader(() => kits.shift() ?? null))
    const firstAtlas = atlas()
    const first = fakePane(firstAtlas)
    const next = fakePane(atlas())
    register(true, [first, next])
    fixture.state.readTimes.push(...Array.from({ length: 15 }, () => start))

    verifyPaneWebglAtlasIntegrity(first, 'reveal', sharedDeps)
    expect(firstReadback).toHaveBeenCalledTimes(issued ? 1 : 0)
    expect(fixture.state.readTimes).toHaveLength(issued ? 16 : 15)
    expect(fixture.state.atlases.get(firstAtlas)?.completedAt).toBe(
      issued ? start : Number.NEGATIVE_INFINITY
    )
    expect(fixture.state.lastAttemptAt).toBe(start)
    expect(first.addon.clearTextureAtlas).not.toHaveBeenCalled()

    fixture.clock += 50
    verifyPaneWebglAtlasIntegrity(next, 'reveal', sharedDeps)
    expect(nextReadback).toHaveBeenCalledTimes(issued ? 0 : 1)
    expect(next.addon.clearTextureAtlas).toHaveBeenCalledTimes(issued ? 0 : 1)
  })

  it.each([
    [-1, false],
    [0, true]
  ] as const)(
    'checks the clear interval at invocation with a %s ms offset from expiry',
    (offset, clearsAgain) => {
      const start = fixture.clock
      const kit = fakeKit()
      const getImageData = kit.ctx.getImageData.bind(kit.ctx)
      vi.spyOn(kit.ctx, 'getImageData').mockImplementation((...args) => {
        fixture.clock += 10
        return getImageData(...args)
      })
      const sharedDeps = deps(createGlyphInkReader(() => kit))
      const paneAtlas = atlas()
      const pane = fakePane(paneAtlas)
      const clearTimes: number[] = []
      pane.addon.clearTextureAtlas.mockImplementation(() => {
        clearTimes.push(fixture.clock)
        evict(paneAtlas)
        fixture.clock++
      })
      register(true, [pane])

      verifyPaneWebglAtlasIntegrity(pane, 'reveal', sharedDeps)
      expect(clearTimes).toEqual([start + 10])
      expect(fixture.state.atlases.get(paneAtlas)?.resetAt).toBe(start + 10)
      expect(fixture.state.atlases.get(paneAtlas)?.completedAt).toBe(start + 11)

      paneAtlas.pages[0].glyphs.push(glyph(0))
      fixture.clock = start + 60_000 + offset
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', sharedDeps)
      expect(clearTimes).toEqual(clearsAgain ? [start + 10, start + 60_010] : [start + 10])
      expect(events.at(-1)?.outcome).toBe(clearsAgain ? 'reset' : 'refused')
    }
  )

  it.each([
    ['an invalid read', fakeReader(() => 'unreadable'), true],
    [
      'a throwing read',
      ((_canvas, _rect, onReadIssued) => {
        onReadIssued()
        throw new Error('readback failed')
      }) as GlyphInkReader,
      true
    ],
    ['an unavailable scratch', (() => 'unavailable') as GlyphInkReader, false]
  ])('charges the shared read budget for %s only if a read was issued', (_name, read, charged) => {
    const spender = fakePane(atlas())
    const third = fakePane(atlas())
    register(true, [spender, third])
    fixture.state.readTimes.push(...Array.from({ length: 15 }, () => fixture.clock))

    verifyPaneWebglAtlasIntegrity(spender, 'reveal', deps(read))
    fixture.clock += 100
    verifyPaneWebglAtlasIntegrity(third, 'reveal', deps(blank))

    expect(third.addon.clearTextureAtlas).toHaveBeenCalledTimes(charged ? 0 : 1)
    expect(fixture.timers).toHaveLength(charged ? 1 : 0)
  })
})
