import { describe, expect, it } from 'vitest'
import { defineSidebarShadowDomain, type SidebarShadowMismatch } from './sidebar-shadow-comparison'

function createDomain() {
  const sides = {
    window: new Map<string, number>(),
    main: new Map<string, number>(),
    revision: 1,
    publishes: true
  }
  const check = defineSidebarShadowDomain<number>({
    name: 'test',
    readWindow: () => sides.window,
    readMain: async () =>
      sides.publishes ? { revision: sides.revision, values: sides.main } : null,
    equals: (a, b) => a === b
  })
  const recorded: SidebarShadowMismatch[] = []
  const run = (): Promise<boolean> => check((mismatch) => recorded.push(mismatch))
  return { sides, run, recorded }
}

describe('defineSidebarShadowDomain', () => {
  it('records a disagreement only once both sides held it for a whole interval', async () => {
    const { sides, run, recorded } = createDomain()
    sides.window.set('a', 1)
    await run()
    expect(recorded).toEqual([])

    await run()
    expect(recorded).toEqual([{ domain: 'test', key: 'a', window: 1, main: null, mainRevision: 1 }])

    await run()
    expect(recorded).toHaveLength(1)
  })

  it('never records lag that either side resolves before the next check', async () => {
    const { sides, run, recorded } = createDomain()
    sides.window.set('a', 1)
    await run()
    sides.main.set('a', 1)
    sides.revision = 2
    await run()
    sides.window.set('b', 2)
    await run()
    sides.revision = 3
    sides.main.set('b', 2)
    await run()
    expect(recorded).toEqual([])
  })

  it('records a held disagreement while other workspaces keep changing', async () => {
    const { sides, run, recorded } = createDomain()
    sides.window.set('a', 1)
    sides.window.set('b', 1)
    sides.main.set('b', 1)
    await run()
    sides.window.set('b', 2)
    sides.main.set('b', 2)
    sides.revision = 2
    await run()
    expect(recorded).toEqual([{ domain: 'test', key: 'a', window: 1, main: null, mainRevision: 2 }])
  })

  it('skips a host that does not publish the domain', async () => {
    const { sides, run, recorded } = createDomain()
    sides.publishes = false
    sides.window.set('a', 1)
    expect(await run()).toBe(false)
    expect(await run()).toBe(false)
    expect(recorded).toEqual([])
  })
})
