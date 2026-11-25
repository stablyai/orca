import { describe, expect, it, vi } from 'vitest'
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
import { fakeKit } from './terminal-webgl-atlas-test-canvas'
import { requestAtlasChangeIntegrityCheck } from './terminal-webgl-atlas-change-hints'
import { verifyPaneWebglAtlasIntegrity } from './terminal-webgl-atlas-integrity'
import { admittedRect, checkAtlasIntegrity, type InkRead } from './terminal-webgl-atlas-sampling'

const fixture = setupAtlasIntegrityFixture()
const { advanceServiceClock, deps, events, register, runTimers, takeScheduledWake } = fixture
const traversal = () => ({ layoutVersion: undefined, cursors: [], startPage: 0 })

describe('admittedRect', () => {
  const page = { width: 512, height: 512 }
  it('admits only glyphs whose top scan provably found ink', () => {
    expect(admittedRect(glyph(0), page)).not.toBeNull()
    // Restricted glyphs use padding 0: a missed top scan gives offset.y 0 (or more with adjustment).
    expect(admittedRect(glyph(0, 0, 0), page)).toBeNull()
    expect(admittedRect(glyph(0, 0, 4), page)).toBeNull()
  })

  it('rejects oversized, fractional and out-of-page rects', () => {
    expect(admittedRect({ ...glyph(0), size: { x: 300, y: 18 } }, page)).toBeNull()
    expect(admittedRect({ ...glyph(0), texturePosition: { x: 0.5, y: 0 } }, page)).toBeNull()
    expect(admittedRect(glyph(508), page)).toBeNull()
  })
})

describe('checkAtlasIntegrity', () => {
  it('reports healthy only when every read in the observed set had ink', () => {
    expect(checkAtlasIntegrity(atlas(), ink, traversal(), 16)).toEqual({
      outcome: 'healthy',
      reads: 1
    })
    const mixed = fakeReader((canvas) => (canvas.width === 512 ? 'ink' : 'unreadable'))
    const twoPages = atlas()
    twoPages.pages.push({ canvas: { width: 1024, height: 1024 }, glyphs: [glyph(0)] })
    expect(checkAtlasIntegrity(twoPages, mixed, traversal(), 16)).toEqual({
      outcome: 'inconclusive',
      reads: 2
    })
  })

  it('acts on a valid blank after an invalid read, but never calls invalid then ink healthy', () => {
    const pages = (results: InkRead[]) => {
      const multi = atlas()
      for (let i = 1; i < results.length; i++) {
        multi.pages.push({ canvas: { width: 512 + i, height: 512 }, glyphs: [glyph(0)] })
      }
      const reader = fakeReader((canvas) => results[canvas.width - 512])
      return [multi, reader] as const
    }
    const [blankAfter, blankReader] = pages(['unreadable', 'blank'])
    expect(checkAtlasIntegrity(blankAfter, blankReader, traversal(), 2)).toMatchObject({
      outcome: 'poisoned',
      reads: 2
    })
    const [inkAfter, inkReader] = pages(['unreadable', 'ink'])
    expect(checkAtlasIntegrity(inkAfter, inkReader, traversal(), 2)).toEqual({
      outcome: 'inconclusive',
      reads: 2
    })
  })

  it('does not credit health from positive alpha read through failed controls', () => {
    const inkedPage = atlas()
    Object.assign(inkedPage.pages[0].canvas, { alphaAt: () => 255 })
    const read = createGlyphInkReader(() => fakeKit({ dropControl: 'both' }))
    expect(checkAtlasIntegrity(inkedPage, read, traversal(), 16)).toEqual({
      outcome: 'inconclusive',
      reads: 1
    })
  })

  it('reads every admitted glyph of a page in turn, one per attempt', () => {
    const merged = atlas([glyph(0), glyph(9), glyph(512), glyph(0, 512), glyph(512, 512)], 1024)
    const blankLast = fakeReader((_canvas, rect) =>
      rect.x === 512 && rect.y === 512 ? 'blank' : 'ink'
    )
    const walk = traversal()
    const outcomes = Array.from(
      { length: 5 },
      () => checkAtlasIntegrity(merged, blankLast, walk, 16).outcome
    )
    expect(outcomes).toEqual(['healthy', 'healthy', 'healthy', 'healthy', 'poisoned'])
  })

  it('finds an admitted rect that lost its pixels', () => {
    expect(checkAtlasIntegrity(atlas(), blank, traversal(), 16)).toEqual({
      outcome: 'poisoned',
      finding: { reason: 'blank-page-glyph', page: 0, pageSize: 512 },
      reads: 1
    })
  })

  it('walks past a long unadmitted prefix across attempts', () => {
    const prefix = Array.from({ length: 64 }, (_, i) => glyph(i, 0, 1))
    const page = atlas([...prefix, glyph(0, 100)])
    const walk = traversal()
    expect(checkAtlasIntegrity(page, blank, walk, 16)).toEqual({
      outcome: 'inconclusive',
      reads: 0
    })
    expect(checkAtlasIntegrity(page, blank, walk, 16)).toMatchObject({ outcome: 'poisoned' })
  })

  it('restarts its walk when the atlas layout changes', () => {
    const page = atlas([glyph(0, 0, 1), glyph(0, 100)])
    const walk = { layoutVersion: 1, cursors: [1], startPage: 0 }
    page.pageLayoutVersion = 2
    page.pages[0].glyphs = [glyph(0, 200)]
    expect(checkAtlasIntegrity(page, blank, walk, 16)).toMatchObject({ outcome: 'poisoned' })
  })
})

describe('verifyPaneWebglAtlasIntegrity', () => {
  it('evicts only the affected atlas and repaints only its eligible visible owners', () => {
    const poisoned = atlas()
    const detecting = fakePane(poisoned)
    const sibling = fakePane(poisoned)
    const coveredLeaf = fakePane(poisoned, { covered: true })
    const lostContext = fakePane(poisoned, { contextLost: true })
    const unrelated = fakePane(atlas())
    const hiddenOwner = fakePane(poisoned)
    register(true, [detecting, sibling, coveredLeaf, lostContext, unrelated])
    register(false, [hiddenOwner])

    verifyPaneWebglAtlasIntegrity(detecting, 'reveal', deps(blank))

    expect(detecting.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(sibling.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(sibling.refresh).toHaveBeenCalled()
    for (const skipped of [coveredLeaf, lostContext, unrelated, hiddenOwner]) {
      expect(skipped.refresh).not.toHaveBeenCalled()
    }
    expect(events).toEqual([
      expect.objectContaining({ kind: 'webgl-atlas-poisoned', outcome: 'reset', trigger: 'reveal' })
    ])
  })

  it('repaints a pane that moved to a different visible root before enumeration catches up', () => {
    const pane = fakePane(atlas())
    const previous = register(true, [pane])
    vi.spyOn(previous, 'containsElement').mockReturnValue(false)
    const current = register(true, [])
    vi.spyOn(current, 'containsElement').mockImplementation((element) => element === pane.container)

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(events).toEqual([expect.objectContaining({ outcome: 'reset' })])
    expect(pane.refresh).toHaveBeenCalled()
  })

  it('reads the clear outcome before presenting, so a repainting owner cannot change it', () => {
    const poisoned = atlas()
    const pane = fakePane(poisoned)
    pane.refresh.mockImplementation(() => poisoned.pages[0].glyphs.push(glyph(0)))
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(events[0]).toMatchObject({ outcome: 'reset' })
  })

  it.each(['an empty atlas', 'a completed eviction'])(
    'records reset-failed when a clear throws after leaving %s and still redraws',
    (result) => {
      const poisoned = atlas()
      const pane = fakePane(poisoned)
      pane.addon.clearTextureAtlas.mockImplementation(() => {
        evict(poisoned)
        if (result === 'an empty atlas') {
          poisoned.pages = []
        }
        throw new Error('page allocation failed')
      })
      const sibling = fakePane(poisoned)
      sibling.refresh.mockImplementation(() => {
        throw new Error('disposed')
      })
      register(true, [sibling, pane])

      expect(() => verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))).not.toThrow()
      expect(events[0]).toMatchObject({ outcome: 'reset-failed' })
      expect(pane.refresh).toHaveBeenCalled()
    }
  )

  it('keeps a coherent DEC 2026 frame by presenting through the synchronized-output path', () => {
    const pane = fakePane(atlas(), { synchronizedOutput: true })
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(pane.refresh).not.toHaveBeenCalled()
    expect(pane.refreshRows).toHaveBeenCalledWith(0, 23, true)
  })

  it('does nothing while the window is parked or hidden', () => {
    const pane = fakePane(atlas())
    register(true, [pane])
    fixture.windowPresented = false

    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(fixture.timers).toHaveLength(0)
  })

  it('lets a zero-read attach leave the following reveal free to check', () => {
    const paneAtlas = atlas([])
    const pane = fakePane(paneAtlas)
    register(true, [pane])

    verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(blank))
    paneAtlas.pages[0].glyphs.push(glyph(0))
    fixture.clock += 100
    verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))

    expect(fixture.timers).toHaveLength(0)
    expect(pane.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('serves deferred requests from one renderer-wide timer', () => {
    const first = atlas()
    const second = atlas()
    const firstPane = fakePane(first)
    const secondPane = fakePane(second)
    register(true, [firstPane, secondPane])

    verifyPaneWebglAtlasIntegrity(firstPane, 'attach', deps(ink))
    verifyPaneWebglAtlasIntegrity(secondPane, 'attach', deps(blank))
    verifyPaneWebglAtlasIntegrity(secondPane, 'reveal', deps(blank))

    expect(fixture.timers).toHaveLength(1)
    runTimers()
    expect(secondPane.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(events[0]).toMatchObject({ trigger: 'deferred' })
  })

  it('hands a deferred check to another eligible owner when the requester is covered', () => {
    const shared = atlas()
    const first = fakePane(shared)
    const requester = { covered: false }
    const second = fakePane(shared, requester)
    register(true, [first, second])

    verifyPaneWebglAtlasIntegrity(first, 'attach', deps(ink))
    fixture.clock += 100
    verifyPaneWebglAtlasIntegrity(second, 'reveal', deps(blank))
    requester.covered = true
    runTimers()

    expect(first.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
  })

  it('retires a deferred check when no eligible owner remains or it expired', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      const shared = atlas()
      const pane = fakePane(shared)
      register(true, [pane])

      verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))
      verifyPaneWebglAtlasIntegrity(pane, 'reveal', deps(blank))
      vi.setSystemTime(Date.now() + 31_000)
      runTimers()

      expect(pane.addon.clearTextureAtlas).not.toHaveBeenCalled()
      expect(fixture.timers).toHaveLength(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runs the atlas-change check on a later task, after xterm assigns the atlas', () => {
    const previous = atlas()
    const current = atlas([glyph(0)], 1024)
    const currentCanvas = current.pages[0].canvas
    const pane = fakePane(previous)
    register(true, [pane])
    const reader = vi.fn(fakeReader((canvas) => (canvas === currentCanvas ? 'blank' : 'ink')))

    requestAtlasChangeIntegrityCheck(pane, pane.webglAddon, deps(reader))
    expect(reader).not.toHaveBeenCalled()
    pane.addon._renderer._charAtlas = current
    runTimers()

    expect(reader.mock.calls.map(([canvas]) => canvas)).toEqual([currentCanvas])
    expect(previous.pageLayoutVersion).toBe(1)
    expect(current.pageLayoutVersion).toBe(2)
    expect(events[0]).toMatchObject({ trigger: 'atlas-change', outcome: 'reset', pageSize: 1024 })
  })

  it('handles an admitted hint through a visible sibling when the publisher is covered', () => {
    const shared = atlas()
    const covered = fakePane(shared, { covered: true })
    const visible = fakePane(shared)
    register(true, [covered, visible])

    requestAtlasChangeIntegrityCheck(covered, covered.webglAddon, deps(blank))
    runTimers()

    expect(covered.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(visible.addon.clearTextureAtlas).toHaveBeenCalled()
    expect(events[0]).toMatchObject({ trigger: 'atlas-change', outcome: 'reset' })
  })

  it.each(['before', 'after'])(
    'retires a hint when its publisher is replaced %s queueing',
    (when) => {
      const pane = fakePane(atlas())
      register(true, [pane])
      const publisher = pane.webglAddon
      const replacement = fakePane(atlas()).webglAddon

      if (when === 'before') {
        pane.webglAddon = replacement
      }
      requestAtlasChangeIntegrityCheck(pane, publisher, deps(blank))
      if (when === 'after') {
        pane.webglAddon = replacement
      }
      runTimers()

      expect(events).toEqual([])
      expect(fixture.state.lastAttemptAt).toBe(Number.NEGATIVE_INFINITY)
    }
  )

  it('charges an admitted request even when its requester is not eligible', () => {
    const shared = atlas()
    const covered = fakePane(shared, { covered: true })
    const visible = fakePane(atlas())
    register(true, [covered, visible])

    verifyPaneWebglAtlasIntegrity(covered, 'reveal', deps(blank))
    verifyPaneWebglAtlasIntegrity(visible, 'reveal', deps(blank))

    expect(visible.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(fixture.timers).toHaveLength(1)
  })

  it.each([
    ['has no eligible owner', { covered: true }],
    ['fails scratch setup', {}]
  ])('serves the second pending atlas after the first %s', (_name, firstOptions) => {
    const busy = fakePane(atlas())
    const first = fakePane(atlas([glyph(0)], 513), firstOptions)
    const second = fakePane(atlas())
    register(true, [busy, first, second])
    // One shared reader, as in production: the first atlas's scratch setup fails, the second reads blank.
    const reader = fakeReader((canvas) => (canvas.width === 513 ? 'unavailable' : 'blank'))
    verifyPaneWebglAtlasIntegrity(busy, 'reveal', deps(ink))
    verifyPaneWebglAtlasIntegrity(first, 'reveal', deps(reader))
    verifyPaneWebglAtlasIntegrity(second, 'reveal', deps(reader))

    runTimers()

    expect(first.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(second.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(fixture.timers).toHaveLength(0)
  })

  it.each([
    ['succeeds and spends read credit', 'ink'],
    ['throws after being selected', 'throw']
  ])('keeps serving the next pending atlas after the first %s', (_name, firstMode) => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = fixture.clock
    const busy = fakePane(atlas())
    const firstAtlas = atlas()
    const secondAtlas = atlas()
    const first = fakePane(firstAtlas)
    const second = fakePane(secondAtlas)
    const observed: string[] = []
    register(true, [busy, first, second])
    if (firstMode === 'throw') {
      Object.defineProperty(firstAtlas, 'pageLayoutVersion', {
        get: () => {
          observed.push('first throws')
          throw new Error('internals changed')
        }
      })
    }
    const sharedDeps = deps(
      fakeReader((canvas) => {
        if (canvas === firstAtlas.pages[0].canvas) {
          observed.push('first reads')
        } else if (canvas === secondAtlas.pages[0].canvas) {
          observed.push('second reads')
          return 'blank'
        }
        return 'ink'
      })
    )
    verifyPaneWebglAtlasIntegrity(busy, 'reveal', sharedDeps)
    verifyPaneWebglAtlasIntegrity(first, 'reveal', sharedDeps)
    verifyPaneWebglAtlasIntegrity(second, 'reveal', sharedDeps)
    expect(observed).toEqual([])
    expect(fixture.state.pending.size).toBe(2)

    const firstWake = takeScheduledWake(50)
    advanceServiceClock(50)
    expect(firstWake).not.toThrow()
    const firstEvent = firstMode === 'throw' ? 'first throws' : 'first reads'
    expect(observed).toEqual([firstEvent])
    expect(fixture.state.readTimes).toEqual(firstMode === 'throw' ? [start] : [start, start + 50])
    expect(fixture.state.pending.size).toBe(1)

    const nextWake = takeScheduledWake(50)
    advanceServiceClock(50)
    nextWake()

    expect(observed).toEqual([firstEvent, 'second reads'])
    expect(fixture.state.readTimes.at(-1)).toBe(start + 100)
    expect(second.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(fixture.state.pending.size).toBe(0)
    expect(fixture.state.serviceTimer).toBeNull()
    expect(fixture.timers).toHaveLength(0)
  })

  it('re-arms a pending wake that later direct work denied, and still serves it', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const start = fixture.clock
    const busy = fakePane(atlas())
    const pendingAtlas = atlas()
    const pendingCanvas = pendingAtlas.pages[0].canvas
    const laterAtlas = atlas()
    const pending = fakePane(pendingAtlas)
    const later = fakePane(laterAtlas)
    register(true, [busy, pending, later])
    const reader = vi.fn(fakeReader((canvas) => (canvas === pendingCanvas ? 'blank' : 'ink')))
    const sharedDeps = deps(reader)
    verifyPaneWebglAtlasIntegrity(busy, 'reveal', sharedDeps)
    verifyPaneWebglAtlasIntegrity(pending, 'reveal', sharedDeps)
    expect(reader).toHaveBeenCalledTimes(1)

    const wake = takeScheduledWake(50)
    advanceServiceClock(50)
    // At the original deadline, direct work spends the spacing slot before the callback runs.
    verifyPaneWebglAtlasIntegrity(later, 'reveal', sharedDeps)
    expect(reader).toHaveBeenCalledTimes(2)
    expect(reader.mock.lastCall?.[0]).toBe(laterAtlas.pages[0].canvas)
    expect(fixture.state.lastAttemptAt).toBe(start + 50)
    expect(fixture.state.readTimes).toEqual([start, start + 50])

    wake()
    expect(reader).toHaveBeenCalledTimes(2)
    expect(pending.addon.clearTextureAtlas).not.toHaveBeenCalled()
    expect(fixture.state.pending.size).toBe(1)

    const nextWake = takeScheduledWake(50)
    advanceServiceClock(50)
    nextWake()

    expect(reader).toHaveBeenCalledTimes(3)
    expect(reader.mock.lastCall?.[0]).toBe(pendingCanvas)
    expect(fixture.state.readTimes).toEqual([start, start + 50, start + 100])
    expect(pending.addon.clearTextureAtlas).toHaveBeenCalledTimes(1)
    expect(fixture.state.pending.size).toBe(0)
    expect(fixture.state.serviceTimer).toBeNull()
    expect(fixture.timers).toHaveLength(0)
  })

  it('never throws into its caller when atlas internals throw', () => {
    const throwing = atlas()
    Object.defineProperty(throwing.pages[0], 'glyphs', {
      get: () => {
        throw new Error('internals changed')
      }
    })
    const pane = fakePane(throwing)
    register(true, [pane])
    expect(() => verifyPaneWebglAtlasIntegrity(pane, 'attach', deps(ink))).not.toThrow()
  })
})
