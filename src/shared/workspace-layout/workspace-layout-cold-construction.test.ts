import { expect, it, vi } from 'vitest'
import * as bindings from './workspace-layout-load-bindings'
import * as invariants from './terminal-owner-invariants'
import { loadWorkspaceLayout } from './workspace-layout-load'
import type { LayoutLeaf } from './workspace-layout-model'
import { addWorkspace, emptySession, GIT_KEY } from './workspace-layout-session.test-fixture'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'

const id = (n: number) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(n).padStart(12, '0')}`

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

const context = (): WorkspaceLayoutLoadContext => ({
  mintId: (seed) => `minted-${seed}`,
  mintLeafId: () => '__proto__',
  ptyGenerationOf: () => 7,
  editorViewsOf: () => undefined
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
      try {
        loadWorkspaceLayout('local', stored, context())
      } finally {
        count.ownerComparisons = predicate.mock.calls.length
        instrument.mockRestore()
        probes.mockRestore()
        predicate.mockRestore()
      }
      expect.soft(count.ownerComparisons).toBe(0)
      expect.soft(count.copiedFields).toBe(0)
      expect.soft(count.copiedKeyBytes).toBe(0)
      expect.soft(count.writes).toBe(population)
      expect.soft(count.writtenKeyBytes).toBe(population * id(0).length)
      expect.soft(count.ownerProbes).toBe(population)
    }
  }
})
