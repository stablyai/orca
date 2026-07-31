import { describe, expect, it, vi } from 'vitest'
import { walkNestedCollectionSizes } from './nested-collection-size-walker'
import { summarizeStateCollectionSizes } from './renderer-memory-profile'

type PaneEntry = { paneKey: string; state: string; stateHistory: { state: string; at: number }[] }

// MAX_ENTRY_VISITS + MAX_KEYS_SCANNED from the walker; nodesVisited sums both.
const NODES_CEILING = 34_000

/** Store shaped like the real one: pane dictionary whose entries hold histories. */
function buildStoreState(options: {
  panes: number
  historyPerPane: number
  worktreesPerRepo?: number
  commentsPerWorktree?: number
}): Record<string, unknown> {
  const agentStatusByPaneKey: Record<string, PaneEntry> = {}
  for (let pane = 0; pane < options.panes; pane += 1) {
    agentStatusByPaneKey[`tab-${pane}:leaf-${pane}`] = {
      paneKey: `tab-${pane}:leaf-${pane}`,
      state: 'working',
      stateHistory: Array.from({ length: options.historyPerPane }, (_, index) => ({
        state: 'idle',
        at: index
      }))
    }
  }
  const worktreesByRepo: Record<string, { id: string; diffComments: { id: string }[] }[]> = {}
  // Real repo ids are randomUUID(), which is what makes the label collapse to `[]`.
  worktreesByRepo['3f2a1c9e-8b74-4d21-9f0a-6c5e2b7d1a83'] = Array.from(
    { length: options.worktreesPerRepo ?? 0 },
    (_, index) => ({
      id: `wt-${index}`,
      diffComments: Array.from({ length: options.commentsPerWorktree ?? 0 }, (_, c) => ({
        id: `c-${c}`
      }))
    })
  )
  return { agentStatusByPaneKey, worktreesByRepo, activeWorktreeId: 'wt-0' }
}

describe('the gap the walker closes', () => {
  it('top-level summary reports an unchanged number while nested entries grow 40x', () => {
    const before = buildStoreState({ panes: 20, historyPerPane: 1 })
    const after = buildStoreState({ panes: 20, historyPerPane: 40 })

    const summaryBefore = summarizeStateCollectionSizes(before, 20)
    const summaryAfter = summarizeStateCollectionSizes(after, 20)

    // The existing breadcrumb: identical before and after 780 new retained objects.
    expect(summaryBefore).toEqual(summaryAfter)
    expect(summaryAfter.agentStatusByPaneKey).toBe(20)

    const walkBefore = walkNestedCollectionSizes(before, 12)
    const walkAfter = walkNestedCollectionSizes(after, 12)

    const beforeHistory = walkBefore.counts['agentStatusByPaneKey[].stateHistory'] ?? 0
    const afterHistory = walkAfter.counts['agentStatusByPaneKey[].stateHistory'] ?? 0
    expect(beforeHistory).toBeGreaterThan(0)
    expect(afterHistory).toBeGreaterThan(beforeHistory * 10)
    expect(afterHistory).toBeLessThanOrEqual(800)
  })

  it('names a three-level-deep container the top-level summary cannot reach', () => {
    const state = buildStoreState({
      panes: 1,
      historyPerPane: 0,
      worktreesPerRepo: 4,
      commentsPerWorktree: 250
    })

    // diffComments has no top-level state key at all, so it is unreported today.
    expect(summarizeStateCollectionSizes(state, 20)).toEqual({
      agentStatusByPaneKey: 1,
      worktreesByRepo: 1
    })

    expect(walkNestedCollectionSizes(state, 12).counts['worktreesByRepo[][].diffComments']).toBe(
      1000
    )
  })

  it('ranks the largest nested container first', () => {
    const state = {
      small: { a: { items: [1, 2, 3] } },
      big: { a: { items: Array.from({ length: 500 }, (_, index) => index) } }
    }

    expect(Object.keys(walkNestedCollectionSizes(state, 1).counts)).toEqual(['big[].items'])
  })

  it('does not spend breadcrumb slots re-reporting top-level keys', () => {
    const walk = walkNestedCollectionSizes({ worktrees: [1, 2, 3] }, 12)

    expect(walk.counts).toEqual({})
  })
})

describe('path labels', () => {
  it('collapses id-like dictionary keys so one path names the whole family', () => {
    const state = {
      byId: Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [
          `2f9c-${index}-uuid-like`,
          { history: [1, 2, 3, 4] }
        ])
      )
    }

    // `byId` itself is a top-level key the existing summary already reports.
    expect(walkNestedCollectionSizes(state, 12).counts).toEqual({ 'byId[].history': 120 })
  })

  it('keeps named properties distinct from dictionary entries', () => {
    const state = { slice: { settings: { tabs: [1, 2], panes: [1, 2, 3] } } }

    // `slice.settings` is a struct, so its field count is not a collection size.
    expect(walkNestedCollectionSizes(state, 12).counts).toEqual({
      'slice.settings.tabs': 2,
      'slice.settings.panes': 3
    })
  })

  it('never leaks dictionary keys into the label, which crash reporting does not sanitize', () => {
    const secretish = '/Users/someone/work/acme-secret-repo'
    const state = {
      byPath: {
        [secretish]: { comments: [1, 2, 3] },
        'C:\\Users\\someone\\proj': { comments: [1, 2] }
      }
    }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['byPath[].comments'])
    expect(paths.join('|')).not.toContain('someone')
  })

  it('collapses a SMALL user-keyed dictionary, whose keys are repo and branch names', () => {
    // The dangerous case: key-count alone reads 3 keys as a struct and emits
    // them verbatim into a breadcrumb that gets uploaded to Slack. Real users
    // have a handful of repos, so this shape is the common one, not the exotic one.
    const state = {
      settingsByRepo: {
        acme_billing_secret: { branches: [1, 2, 3] },
        project_darkstar: { branches: [1, 2] },
        clientwork: { branches: [1] }
      }
    }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['settingsByRepo[].branches'])
    expect(paths.join('|')).not.toMatch(/acme|darkstar|clientwork/)
  })

  it('collapses a ONE-entry dictionary, where there is no sibling to compare shape against', () => {
    // Repeated-shape detection cannot fire on a single entry, so the key syntax
    // rule is the only thing left; a branch name must still not reach the label.
    const state = { draftsByBranch: { feature_ceo_comp_model: { comments: [1, 2, 3] } } }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['draftsByBranch[].comments'])
    expect(paths.join('|')).not.toContain('ceo_comp')
  })

  it('collapses a source-vocabulary branch name when a sibling gives the set away', () => {
    // `comments` is both an approved label and a legal branch name.
    // Entry shapes DIFFER, so repeated-shape detection cannot fire; the
    // approved key would pass on its own. Only the user-shaped sibling saves it.
    const state = {
      draftsByBranch: {
        comments: { items: [1, 2, 3] },
        'fix/login-crash': { items: [1], resolved: true }
      }
    }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['draftsByBranch[].items'])
    expect(paths.join('|')).not.toContain('draftsByBranch.comments')
  })

  it('collapses approved-looking dictionary keys when entry shapes repeat', () => {
    const state = {
      settingsByRepo: {
        comments: { branches: [1, 2, 3] },
        history: { branches: [1, 2] }
      }
    }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['settingsByRepo[].branches'])
    expect(paths.join('|')).not.toMatch(/settingsByRepo\.(comments|history)/)
  })

  it('collapses a one-entry camelCase user key despite its field-like shape', () => {
    const state = {
      settingsByRepo: {
        acmeBillingSecret: { branches: [1, 2, 3] }
      }
    }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['settingsByRepo[].branches'])
    expect(paths.join('|')).not.toContain('acmeBillingSecret')
  })

  it('collapses all-camelCase user keys whose entry shapes differ', () => {
    const state = {
      draftsByBranch: {
        featureCeoCompModel: { comments: [1, 2, 3] },
        releaseCustomerSecret: { comments: [1], resolved: true }
      }
    }

    const paths = Object.keys(walkNestedCollectionSizes(state, 12).counts)

    expect(paths).toEqual(['draftsByBranch[].comments'])
    expect(paths.join('|')).not.toMatch(/featureCeoCompModel|releaseCustomerSecret/)
  })

  it('rejects non-camelCase key shapes that user data takes', () => {
    const state = {
      slice: {
        'kebab-branch-name': { items: [1] },
        snake_case_repo: { items: [1, 2] },
        '9f2a-4c81-uuid': { items: [1, 2, 3] },
        'C:\\Users\\someone': { items: [1, 2, 3, 4] }
      }
    }

    for (const path of Object.keys(walkNestedCollectionSizes(state, 12).counts)) {
      expect(path).not.toMatch(/kebab|snake|uuid|someone/)
    }
  })

  it('drops a path label that would exceed the breadcrumb key budget', () => {
    const longKey = 'k'.repeat(90)
    const state = { slice: { [longKey]: { items: [1, 2, 3] } } }

    for (const path of Object.keys(walkNestedCollectionSizes(state, 12).counts)) {
      expect(path.length).toBeLessThanOrEqual(64)
    }
  })

  it('reports a dictionary field but not a struct field, at the same depth', () => {
    const state = {
      slice: {
        struct: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`field${i}`, i])),
        dictionary: Object.fromEntries(Array.from({ length: 400 }, (_, i) => [`id-${i}`, i]))
      }
    }

    expect(walkNestedCollectionSizes(state, 12).counts).toEqual({ 'slice.dictionary': 400 })
  })
})

describe('safety rails', () => {
  it('survives a cycle instead of hanging', () => {
    const node: Record<string, unknown> = { items: [1, 2, 3] }
    node.self = node
    const nested: Record<string, unknown> = { child: node }
    node.parent = nested

    const walk = walkNestedCollectionSizes({ root: nested }, 12)

    expect(walk.counts['root.child.items']).toBe(3)
  })

  it('counts a shared reference once rather than once per referrer', () => {
    const shared = { entries: [1, 2, 3, 4, 5] }
    const walk = walkNestedCollectionSizes({ a: { s: shared }, b: { s: shared } }, 12)

    expect(walk.counts['a[].entries']).toBe(5)
    expect(walk.counts['b[].entries']).toBeUndefined()
  })

  it('never enters class instances, so xterm/fiber-shaped fan-out is unreachable', () => {
    // Real fibers/xterm hold their fan-out in OWN instance fields, which for-in
    // enumerates — a prototype getter would not exercise the guard at all.
    class FiberLike {
      readonly child = { grandchild: Array.from({ length: 500 }, () => 0) }
      readonly stateNode = { buffers: Array.from({ length: 500 }, () => 0) }
      readonly memoizedState = { queue: Array.from({ length: 500 }, () => 0) }
    }
    const walk = walkNestedCollectionSizes({ terminals: { pane: new FiberLike() } }, 12)

    // Nothing under the instance may be reported, at any depth.
    expect(walk.counts).toEqual({})
  })

  it('does not descend through a Map VALUE that is a class instance', () => {
    class TerminalLike {
      readonly buffer = { lines: Array.from({ length: 900 }, () => 0) }
    }
    const byPane = new Map([['pane-1', new TerminalLike()]])

    const walk = walkNestedCollectionSizes({ slice: { byPane } }, 12)

    expect(walk.counts).toEqual({ 'slice.byPane': 1 })
  })

  it('never enters DOM-shaped or React-element-shaped objects', () => {
    const domLike = { nodeType: 1, childNodes: Array.from({ length: 500 }, () => ({})) }
    const reactLike = { $$typeof: Symbol.for('react.element'), props: { children: [1, 2, 3] } }

    const walk = walkNestedCollectionSizes({ a: { dom: domLike }, b: { el: reactLike } }, 12)

    expect(walk.counts['a.dom.childNodes']).toBeUndefined()
    expect(walk.counts['b.el.props']).toBeUndefined()
  })

  it('skips accessors without invoking them', () => {
    let getterCalls = 0
    const hostile = {
      list: [1, 2, 3],
      get boom(): unknown {
        getterCalls += 1
        return { history: [1, 2, 3] }
      }
    }
    const walk = walkNestedCollectionSizes({ slice: hostile }, 12)

    expect(getterCalls).toBe(0)
    expect(walk.truncated).toBe(true)
    expect(walk.counts).toEqual({ 'slice.list': 3 })
  })

  it('skips array index accessors without invoking them', () => {
    let getterCalls = 0
    const array = [null]
    Object.defineProperty(array, 0, {
      enumerable: true,
      get: () => {
        getterCalls += 1
        return { history: [1, 2, 3] }
      }
    })

    const walk = walkNestedCollectionSizes({ slice: { list: array } }, 12)

    expect(getterCalls).toBe(0)
    expect(walk.truncated).toBe(true)
  })

  it('isolates a throwing slice so its SIBLING slices are still reported', () => {
    const state = {
      hostile: {
        get boom(): never {
          throw new Error('nope')
        }
      },
      healthy: { comments: Array.from({ length: 40 }, () => 0) },
      alsoHealthy: { history: Array.from({ length: 25 }, () => 0) }
    }

    const walk = walkNestedCollectionSizes(state, 12)

    // Without per-frame isolation the throw would abort the whole walk and
    // these siblings would vanish from the breadcrumb.
    expect(walk.counts['healthy.comments']).toBe(40)
    expect(walk.counts['alsoHealthy.history']).toBe(25)
    expect(walk.truncated).toBe(true)
  })

  it('survives every exotic value a real store could hold', () => {
    const nullPrototype = Object.create(null) as Record<string, unknown>
    nullPrototype.items = [1, 2, 3]
    const selfReferential: unknown[] = [1]
    selfReferential.push(selfReferential)

    const exotic: unknown[] = [
      new Proxy(
        {},
        {
          ownKeys: () => {
            throw new Error('nope')
          }
        }
      ),
      new Proxy(
        { a: {} },
        {
          get: () => {
            throw new Error('nope')
          }
        }
      ),
      {
        get boom(): never {
          throw new Error('nope')
        }
      },
      {
        get nodeType(): never {
          throw new Error('nope')
        }
      },
      {
        [Symbol.toPrimitive]: () => {
          throw new Error('nope')
        },
        items: [1, 2]
      },
      nullPrototype,
      new Uint8Array(64),
      new WeakMap(),
      Promise.resolve(1),
      Object.freeze({ a: Object.freeze({ items: [1, 2, 3] }) }),
      selfReferential,
      { d: new Date(), r: /x/g, items: [1] },
      Array.from({ length: 16 })
    ]

    for (const value of exotic) {
      expect(() => walkNestedCollectionSizes({ root: value }, 12)).not.toThrow()
    }
  })

  it('does not throw on non-object roots', () => {
    for (const root of [null, undefined, 7, 'x', Symbol('s')]) {
      expect(walkNestedCollectionSizes(root, 12).counts).toEqual({})
    }
  })
})

describe('node budget', () => {
  it('stays under the budget on a pathologically wide store and flags truncation', () => {
    const state = {
      wide: Object.fromEntries(
        Array.from({ length: 50_000 }, (_, index) => [`k${index}`, { items: [1, 2, 3] }])
      )
    }

    // Freeze time to isolate node caps; the real deadline has its own stress test below.
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const walk = walkNestedCollectionSizes(state, 12)
    now.mockRestore()
    const reported = walk.counts['wide[].items'] ?? 0

    expect(walk.nodesVisited).toBeLessThanOrEqual(NODES_CEILING)
    expect(walk.estimated || walk.truncated).toBe(true)
    // Past the key cap the contract is a flagged LOWER BOUND, not an estimate:
    // truncated says "at least this much", which still names the container and
    // still moves when it grows. Reporting the sample size would not.
    expect(walk.truncated).toBe(true)
    expect(reported).toBeGreaterThan(50_000)
    expect(reported).toBeLessThanOrEqual(150_000)
  })

  it('keeps rising as a huge dictionary grows, instead of saturating', () => {
    const build = (panes: number): Record<string, unknown> => ({
      panes: Object.fromEntries(
        Array.from({ length: panes }, (_, index) => [`p${index}`, { history: [1, 2, 3, 4, 5] }])
      )
    })

    const at3k = walkNestedCollectionSizes(build(3000), 12).counts['panes[].history'] ?? 0
    const at9k = walkNestedCollectionSizes(build(9000), 12).counts['panes[].history'] ?? 0

    // A saturating count would report the same number twice and hide the leak.
    expect(at9k).toBeGreaterThan(at3k * 2)
  })

  it('bounds ENTRY visits on a wide-and-deep store whose keys are never scanned', () => {
    // Why arrays specifically: the key-scan budget does not apply to them, so
    // this is the only shape where MAX_ENTRY_VISITS is the sole thing standing
    // between the walker and a half-million entry reads. Mutating that constant
    // away leaves every other test in this file passing.
    const state: Record<string, unknown> = {}
    for (let slice = 0; slice < 256; slice += 1) {
      state[`slice${slice}`] = Array.from({ length: 2000 }, () => ({ items: [1, 2, 3] }))
    }

    // Freeze time to isolate the entry cap; the real deadline has its own stress test below.
    const now = vi.spyOn(performance, 'now').mockReturnValue(0)
    const walk = walkNestedCollectionSizes(state, 12)
    now.mockRestore()

    // 512_000 entries exist; an unbudgeted walk reads all of them.
    expect(walk.nodesVisited).toBeLessThanOrEqual(10_000)
    expect(walk.estimated).toBe(true)
    // Bounded, but still names the container rather than going silent.
    expect(Object.keys(walk.counts).some((path) => path.endsWith('[].items'))).toBe(true)
  })

  it('stays under the budget on a pathologically deep store', () => {
    let deep: Record<string, unknown> = { items: [1, 2, 3] }
    for (let level = 0; level < 5000; level += 1) {
      deep = { child: deep }
    }

    const walk = walkNestedCollectionSizes({ root: deep }, 12)

    expect(walk.nodesVisited).toBeLessThanOrEqual(NODES_CEILING)
    expect(Object.keys(walk.counts).every((path) => path.split('.').length <= 5)).toBe(true)
  })

  it('bounds the reported path count regardless of store fan-out', () => {
    const state = Object.fromEntries(
      Array.from({ length: 200 }, (_, index) => [
        `slice${index}`,
        { [`child${index}`]: { items: [1, 2] } }
      ])
    )

    expect(Object.keys(walkNestedCollectionSizes(state, 12).counts)).toHaveLength(12)
  })

  it('scales a sampled count toward the true population', () => {
    const state = {
      panes: Object.fromEntries(
        Array.from({ length: 1000 }, (_, index) => [`p${index}`, { history: [1, 2, 3, 4, 5] }])
      )
    }
    summarizeStateCollectionSizes(state, 20)
    const walk = walkNestedCollectionSizes(state, 12)
    const reported = walk.counts['panes[].history'] ?? 0

    expect(walk.estimated).toBe(true)
    // True total is 5_000; sampling must land within 2x, not report the sample.
    expect(reported).toBeGreaterThan(2500)
    expect(reported).toBeLessThan(10_000)
  })

  it('bounds WALL TIME when a store holds objects too big for a node budget to help', () => {
    // Why node budgets are not enough: `for...in` materializes V8's enumeration
    // cache for the whole object before yielding key one, so an 8-key sample of
    // a 300k-key value costs O(300k). This shape measured 3.3s unbounded.
    const slice: Record<string, unknown> = {}
    for (let entry = 0; entry < 10; entry += 1) {
      const huge: Record<string, unknown> = {}
      for (let field = 0; field < 300_000; field += 1) {
        huge[`f${field}`] = field
      }
      slice[`entry${entry}`] = huge
    }

    const startedAt = performance.now()
    const walk = walkNestedCollectionSizes({ slice }, 12)
    const elapsed = performance.now() - startedAt

    // Generous vs. the ~75ms measured: one for-in is uninterruptible, so the
    // deadline bounds how many are STARTED, not how long one runs.
    expect(elapsed).toBeLessThan(600)
    expect(walk.truncated).toBe(true)
  })

  it('is exact and unflagged when the store fits inside the budget', () => {
    const state = buildStoreState({ panes: 30, historyPerPane: 20 })
    walkNestedCollectionSizes(state, 12)
    const walk = walkNestedCollectionSizes(state, 12)

    expect(walk.estimated).toBe(false)
    expect(walk.truncated).toBe(false)
    expect(walk.counts['agentStatusByPaneKey[].stateHistory']).toBe(600)
  })
})

describe('cost on a realistically-sized store', () => {
  it('completes a realistic store well inside a frame budget', () => {
    const state = buildStoreState({
      panes: 300,
      historyPerPane: 20,
      worktreesPerRepo: 120,
      commentsPerWorktree: 30
    })

    // Warm up so the measurement is steady-state, not first-call JIT.
    for (let run = 0; run < 20; run += 1) {
      walkNestedCollectionSizes(state, 12)
    }
    const startedAt = performance.now()
    const runs = 200
    for (let run = 0; run < runs; run += 1) {
      walkNestedCollectionSizes(state, 12)
    }
    const msPerRun = (performance.now() - startedAt) / runs
    const walk = walkNestedCollectionSizes(state, 12)

    // Generous vs. the measured cost so slow CI machines don't flake; the real
    // guarantee is the node budget asserted above, which is deterministic.
    expect(msPerRun).toBeLessThan(15)
    expect(walk.nodesVisited).toBeLessThanOrEqual(NODES_CEILING)
    expect(walk.counts['agentStatusByPaneKey[].stateHistory']).toBeGreaterThan(3000)
    expect(walk.counts['agentStatusByPaneKey[].stateHistory']).toBeLessThan(12_000)
    expect(walk.counts['worktreesByRepo[][].diffComments']).toBeGreaterThan(1800)
    expect(walk.counts['worktreesByRepo[][].diffComments']).toBeLessThan(7200)
  })
})
