import { expect, it, vi } from 'vitest'
import { loadWorkspaceLayout } from './workspace-layout-load'
import * as workspaceLoader from './workspace-layout-load-workspace'
import type { WorkspaceSessionState } from '../workspace-session-state-types'
import type { WorkspaceLayoutLoadContext } from './workspace-layout-load-types'
import type { WorkspaceLayout } from './workspace-layout-model'
import { nameBasedLoadContext } from './workspace-layout-minted-ids'
import { populations, coldInput } from './workspace-layout-cold-local.test-fixture'

vi.mock('../layout-owner-switch', () => ({ ORCA_LAYOUT_OWNER_IS_MAIN: true }))

const context = (): WorkspaceLayoutLoadContext => ({
  mintId: (seed) => `minted-${seed}`,
  mintLeafId: (seed) => nameBasedLoadContext().mintLeafId(seed),
  editorViewsOf: () => undefined,
  ptyGenerationOf: () => 3
})

function measured(stored: WorkspaceSessionState) {
  const counts = {
    namingComparisons: 0,
    browserComparisons: 0,
    groupComparisons: 0,
    recordKeys: 0,
    closedCopies: 0,
    closedWrites: 0,
    closedKeyBytes: 0
  }
  const restore: (() => void)[] = []
  const some = Array.prototype.some
  const find = Array.prototype.find
  function charge(value: unknown) {
    if (typeof value !== 'object' || value === null) {
      return
    }
    if ('contentType' in value) {
      counts.namingComparisons++
    }
    if ('kind' in value) {
      counts.browserComparisons++
    }
    if ('tabOrder' in value) {
      counts.groupComparisons++
    }
  }
  const scans = vi.spyOn(Array.prototype, 'some').mockImplementation(function (
    this: unknown[],
    predicate,
    receiver
  ) {
    return some.call(this, (value, index, array) => {
      charge(value)
      return predicate.call(receiver, value, index, array)
    })
  })
  const finds = vi.spyOn(Array.prototype, 'find').mockImplementation(function (
    this: unknown[],
    predicate,
    receiver
  ) {
    return find.call(this, (value, index, array) => {
      charge(value)
      return predicate.call(receiver, value, index, array)
    })
  })
  const keys = Object.keys
  const keyScan = vi.spyOn(Object, 'keys').mockImplementation((value) => {
    const result = keys(value)
    if (result.some((key) => key.startsWith('unrelated-'))) {
      counts.recordKeys += result.length
    }
    return result
  })
  const original = workspaceLoader.loadWorkspace
  const capture = vi.spyOn(workspaceLoader, 'loadWorkspace').mockImplementation((...args) => {
    const workspace = original(...args)
    let current: WorkspaceLayout['closedTerminalTabs']
    let view: WorkspaceLayout['closedTerminalTabs']
    Object.defineProperty(workspace, 'closedTerminalTabs', {
      configurable: true,
      get: () => view,
      set: (next: NonNullable<WorkspaceLayout['closedTerminalTabs']>) => {
        current = next
        view = new Proxy(next, {
          ownKeys(target) {
            const names = Object.getOwnPropertyNames(target)
            counts.closedCopies += names.length
            return names
          },
          defineProperty(target, key, descriptor) {
            counts.closedWrites++
            counts.closedKeyBytes += String(key).length
            Object.defineProperty(target, key, descriptor)
            return true
          }
        })
      }
    })
    restore.push(() => {
      delete workspace.closedTerminalTabs
      if (current !== undefined) {
        workspace.closedTerminalTabs = current
      }
    })
    return workspace
  })
  try {
    loadWorkspaceLayout('local', stored, context())
  } finally {
    for (const mock of [scans, finds, keyScan, capture]) {
      mock.mockRestore()
    }
    for (const release of restore) {
      release()
    }
  }
  return counts
}

it('charges each local cold-load population separately at N and 10N', () => {
  for (const kind of populations) {
    for (const n of [10, 100]) {
      const stored = coldInput(kind, n)
      const before = structuredClone(stored)
      const counts = measured(structuredClone(stored))
      if (kind === 'closed') {
        expect(counts.closedCopies).toBe(n)
        expect(counts.closedWrites).toBe(n)
      }
      if (kind === 'home-rows' || kind === 'home-names') {
        expect(counts.namingComparisons).toBe(0)
      }
      if (kind === 'legacy') {
        expect(counts.recordKeys).toBe(2 * n)
      }
      if (kind === 'groups') {
        expect(counts.groupComparisons).toBeLessThanOrEqual(n)
      }
      if (kind === 'browser') {
        expect(counts.browserComparisons).toBe(0)
      }
      expect(stored).toEqual(before)
    }
  }
})
