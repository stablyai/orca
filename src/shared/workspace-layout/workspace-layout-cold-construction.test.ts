import { createHash } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import * as bindings from './workspace-layout-load-bindings'
import * as invariants from './terminal-owner-invariants'
import { loadWorkspaceLayout } from './workspace-layout-load'
import { saveWorkspaceLayout } from './workspace-layout-save'
import type { LayoutLeaf } from './workspace-layout-model'
import { tabsInOrder } from './workspace-layout-model'
import { collectLayoutLeafIdsInOrder } from './terminal-pane-tree'
import { addWorkspace, emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function input(keys: string[], pty = (i: number) => `bound-cold-${i}`) {
  return addWorkspace(emptySession(), GIT_KEY, [
    {
      id: 'g1',
      tabs: keys.map((key, i) => ({
        id: `tab-${i}`,
        leaves: [[key, pty(i)]],
        layout: {
          titlesByLeafId: { [key]: `title-${i}` },
          buffersByLeafId: { [key]: `buffer-${i}` }
        }
      }))
    }
  ])
}

function context(
  events: string[],
  failAt?: string,
  fault = new Error('generation-fault')
): WorkspaceLayoutLoadContext {
  return {
    mintId: (seed) => {
      events.push(`id:${seed}`)
      return `minted-${seed}`
    },
    mintLeafId: (seed) => {
      events.push(`leaf:${seed}`)
      return '__proto__'
    },
    ptyGenerationOf: (leaf) => {
      events.push(`generation:${leaf}`)
      if (leaf === failAt) {
        throw fault
      }
      return 7
    },
    editorViewsOf: (key) => {
      events.push(`editor:${key}`)
      return undefined
    }
  }
}

it('preserves ordered load/save/report, special data keys, remint collisions and callback failure prefixes', () => {
  const keys = ['__proto__', 'constructor', 'toString', '2', '1', id(0), id(0), id(1)]
  const stored = input(keys)
  stored.terminalPtyIncarnationsByPaneKey = { [`tab-0:__proto__`]: '', orphan: 'carried' }
  const before = structuredClone(stored)
  const events: string[] = []
  const loaded = loadWorkspaceLayout('local', stored, context(events))
  const leaves = loaded.layout.workspaces[GIT_KEY].leaves!
  expect(Object.getPrototypeOf(leaves)).toBe(Object.prototype)
  expect(Object.keys(leaves)).toEqual([
    '1',
    '2',
    '__proto__',
    'constructor',
    'toString',
    id(0),
    id(1)
  ])
  expect(Object.getOwnPropertyDescriptor(leaves, '__proto__')).toEqual({
    value: { title: 'title-6' },
    enumerable: true,
    configurable: true,
    writable: true
  })
  expect(loaded.carried.unplacedIncarnations).toEqual({ orphan: 'carried' })
  expect(stored).toEqual(before)
  const receipt = digest({ loaded, saved: saveWorkspaceLayout(loaded), events })
  expect(receipt).toBe('85a10dfeefaea8b3ab7bd10437ba62264c5bdb0fba6d814c663905bbbfb5c484')
  const borrowed = leaves
  const borrowedBefore = structuredClone(borrowed)
  bindings.loadLeaves(
    loaded.layout,
    {
      session: structuredClone(stored),
      layouts: new Map(Object.entries(stored.terminalLayoutsByTabId))
    },
    { view: loaded.desktopView, facts: loaded.facts, carried: loaded.carried },
    context([])
  )
  expect(loaded.layout.workspaces[GIT_KEY].leaves).not.toBe(borrowed)
  expect(borrowed).toEqual(borrowedBefore)
  const failedEvents: string[] = []
  const fault = new Error('generation-fault')
  let thrown: unknown
  try {
    loadWorkspaceLayout('local', stored, context(failedEvents, id(0), fault))
  } catch (error) {
    thrown = error
  }
  expect(thrown).toBe(fault)
  expect(failedEvents).toEqual(events.slice(0, events.indexOf(`generation:${id(0)}`) + 1))
  expect(stored).toEqual(before)
  const empty = input([id(0)])
  empty.terminalLayoutsByTabId['tab-0'].ptyIdsByLeafId = {}
  delete empty.terminalLayoutsByTabId['tab-0'].titlesByLeafId
  const absent = loadWorkspaceLayout('local', empty, {
    mintId: (seed) => seed,
    mintLeafId: (seed) => seed
  })
  expect(Object.hasOwn(absent.layout.workspaces[GIT_KEY], 'leaves')).toBe(false)
})

it('matches the accepted binding-value predicate walk for missing/empty/relay incarnations and repeated leaf aliases', () => {
  for (const pty of [
    '__proto__',
    'ordinary',
    'ssh:box@@pty-1',
    'ssh:box@@pty-01',
    'ssh:%zz@@pty-1',
    'ssh:box@@custom'
  ]) {
    for (const sequence of [
      ['A', undefined, 'B', '', '', undefined],
      [undefined, undefined, '', 'A', 'A', 'B']
    ]) {
      const stored = input(
        sequence.map((_, i) => id(i)),
        () => pty
      )
      stored.terminalPtyIncarnationsByPaneKey = Object.fromEntries(
        sequence.flatMap((incarnation, i) =>
          incarnation === undefined ? [] : [[`tab-${i}:${id(i)}`, incarnation]]
        )
      )
      const legacy = vi.spyOn(bindings, 'unbindDuplicateTerminals').mockImplementation((model) => {
        const owners: { ptyId: string; incarnationId?: string }[] = []
        for (const workspace of Object.values(model.workspaces)) {
          for (const tab of tabsInOrder(workspace)) {
            if (tab.kind !== 'terminal') {
              continue
            }
            for (const key of collectLayoutLeafIdsInOrder(tab.panes.root)) {
              const leaf = workspace.leaves?.[key]
              if (leaf?.ptyId === undefined) {
                continue
              }
              const binding = { ptyId: leaf.ptyId, incarnationId: leaf.incarnationId }
              if (owners.some((owner) => invariants.isSameTerminal(owner, binding))) {
                delete leaf.ptyId
              } else {
                owners.push(binding)
              }
            }
          }
        }
      })
      const baseline = loadWorkspaceLayout('local', structuredClone(stored), context([]))
      legacy.mockRestore()
      const candidate = loadWorkspaceLayout('local', structuredClone(stored), context([]))
      expect(JSON.stringify(candidate)).toBe(JSON.stringify(baseline))
      expect(JSON.stringify(saveWorkspaceLayout(candidate))).toBe(
        JSON.stringify(saveWorkspaceLayout(baseline))
      )
    }
  }
  // A colliding remint visits the same leaf again after duplicate rejection has deleted its PTY.
  const stored = input([id(0), id(0), '__proto__'], () => 'ordinary')
  const loaded = loadWorkspaceLayout('local', stored, context([]))
  expect(loaded.layout.workspaces[GIT_KEY].leaves?.['__proto__']?.ptyId).toBeUndefined()
})

it('charges actual cold and invalidated construction copies, key bytes and accepted-owner probes at N and 10N', () => {
  for (const population of [10, 100]) {
    for (const invalidated of [false, true]) {
      const stored = input(Array.from({ length: population }, (_, i) => id(i)))
      if (invalidated) {
        stored.terminalLayoutsByTabId['tab-0'].ptyIdsByLeafId = {
          [id(0)]: 'bound-cold-replacement'
        }
      }
      const count = {
        copiedFields: 0,
        copiedKeyBytes: 0,
        writes: 0,
        writtenKeyBytes: 0,
        ownerProbes: 0,
        ownerComparisons: 0
      }
      const original = bindings.loadLeaves
      const instrument = vi.spyOn(bindings, 'loadLeaves').mockImplementation((model, ...args) => {
        const workspace = model.workspaces[GIT_KEY]
        let current = workspace.leaves
        let view = current
        Object.defineProperty(workspace, 'leaves', {
          configurable: true,
          enumerable: true,
          get: () => view,
          set: (next: Record<string, LayoutLeaf>) => {
            current = next
            view = new Proxy(next, {
              ownKeys: (target) => {
                const keys = Object.getOwnPropertyNames(target)
                count.copiedFields += keys.length
                count.copiedKeyBytes += keys.reduce(
                  (bytes, key) => bytes + Buffer.byteLength(key),
                  0
                )
                return keys
              },
              defineProperty: (target, key, descriptor) => {
                count.writes++
                count.writtenKeyBytes += Buffer.byteLength(String(key))
                Object.defineProperty(target, key, descriptor)
                return true
              }
            })
          }
        })
        try {
          original(model, ...args)
        } finally {
          delete workspace.leaves
          if (current !== undefined) {
            workspace.leaves = current
          }
        }
      })
      const predicate = vi.spyOn(invariants, 'isSameTerminal')
      const get = Map.prototype.get
      const probes = vi.spyOn(Map.prototype, 'get').mockImplementation(function (
        this: Map<unknown, unknown>,
        key: unknown
      ) {
        if (typeof key === 'string' && key.startsWith('bound-cold-')) {
          count.ownerProbes++
        }
        return get.call(this, key)
      })
      let loaded: ReturnType<typeof loadWorkspaceLayout>
      try {
        loaded = loadWorkspaceLayout('local', stored, context([]))
      } finally {
        count.ownerComparisons = predicate.mock.calls.length
        instrument.mockRestore()
        probes.mockRestore()
        predicate.mockRestore()
      }
      console.log('cold construction receipt', {
        population,
        invalidated,
        ...count,
        full: digest({ loaded, saved: saveWorkspaceLayout(loaded) })
      })
      const expected = new Map([
        ['10:false', '32660b6065dfb37c9bfd94b71e26020c8f3eddfe4bb97f8aa9e55e4a9eeb27b6'],
        ['10:true', '21ff9175ed096311fdae0f057e984bb6206296439d5926f57e8368852e94d1ca'],
        ['100:false', '2252ea554899599621f08013705c7cec73ae6e44fc06635df439fd21355f7038'],
        ['100:true', '53c6317af210fff09a69242003b2f022080f86614674776fcb6376a14d7fa247']
      ])
      expect(digest({ loaded, saved: saveWorkspaceLayout(loaded) })).toBe(
        expected.get(`${population}:${invalidated}`)
      )
      expect.soft(count.ownerComparisons).toBe(0)
      expect.soft(count.copiedFields).toBe(0)
      expect.soft(count.copiedKeyBytes).toBe(0)
      expect.soft(count.writes).toBe(population)
      expect.soft(count.writtenKeyBytes).toBe(population * id(0).length)
      expect.soft(count.ownerProbes).toBe(population)
    }
  }
})
