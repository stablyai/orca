import { describe, expect, it } from 'vitest'
import { URI } from 'monaco-editor/esm/vs/base/common/uri.js'
import type { OpenFile } from '@/store/slices/editor'
import type { WorktreeOperationRoute } from '@/lib/worktree-operation-route'
import { getEditorModelOwnerKey } from './editor-model-owner'
import { toEditorModelUri } from './editor-model-uri'

// Keep the prior fragment-owner URI as an oracle for which tabs share models.
function legacyEditorModelUri(filePath: string, ownerKey = ''): string {
  const parsed = /^file:/i.test(filePath) ? URI.parse(filePath) : URI.file(filePath)
  return URI.file(parsed.fsPath)
    .with({ fragment: ownerKey || parsed.fragment })
    .toString()
}

const LOCAL: WorktreeOperationRoute = { executionHostId: 'local', runtimeEnvironmentId: null }
const SSH: WorktreeOperationRoute = { executionHostId: 'ssh:target', runtimeEnvironmentId: null }
const RUNTIME: WorktreeOperationRoute = {
  executionHostId: 'runtime:hub-a',
  runtimeEnvironmentId: 'hub-a'
}
const SSH_IN_RUNTIME: WorktreeOperationRoute = {
  executionHostId: 'ssh:target',
  runtimeEnvironmentId: 'hub-a'
}
const SSH_IN_OTHER_RUNTIME: WorktreeOperationRoute = {
  executionHostId: 'ssh:target',
  runtimeEnvironmentId: 'hub-b'
}

function tab(
  id: string,
  filePath: string,
  route: WorktreeOperationRoute | null,
  worktreeId = 'wt-1'
): OpenFile {
  return {
    id,
    filePath,
    relativePath: 'a.ts',
    worktreeId,
    language: 'typescript',
    isDirty: false,
    mode: 'edit',
    ...(route
      ? {
          runtimeEnvironmentId: route.runtimeEnvironmentId,
          operationProvenance: {
            ownershipProjection: 'explicit' as const,
            generation: {
              route,
              runtimeConnectionGeneration: null,
              runtimePairingRevision: undefined,
              runtimeSshGeneration: null,
              nestedSshGeneration: null,
              directSshGeneration: null
            }
          }
        }
      : { runtimeEnvironmentId: null })
  }
}

const PATHS = [
  '/repo/a.ts',
  '/repo/A.ts',
  '/repo/a b.ts',
  '/repo/a%20b.ts',
  '/repo/a#b.ts',
  'file:///repo/a.ts',
  'C:/repo/a.ts',
  'c:/repo/a.ts',
  'C:\\repo\\a.ts',
  'file:///C:/repo/a.ts',
  '\\\\server\\share\\a.ts',
  '//server/share/a.ts',
  '\\\\wsl$\\Ubuntu\\home\\a.ts',
  '\\\\wsl.localhost\\Ubuntu\\home\\a.ts',
  '//wsl$/Ubuntu/home/a.ts',
  '//wsl.localhost/ubuntu/home/a.ts'
]
const ROUTES = [LOCAL, SSH, RUNTIME, SSH_IN_RUNTIME, SSH_IN_OTHER_RUNTIME, null]

const TABS = PATHS.flatMap((filePath, pathIndex) =>
  ROUTES.flatMap((route, routeIndex) =>
    // Resolved same-host workspace views share one model; unresolved owners remain isolated.
    ['wt-1', 'wt-2'].map((worktreeId) =>
      tab(`${worktreeId}:${pathIndex}:${routeIndex}`, filePath, route, worktreeId)
    )
  )
)

describe('owner-folder model URIs', () => {
  it('share a model between exactly the tabs the fragment-owner URIs shared', () => {
    const keyed = TABS.map((file) => {
      const owner = getEditorModelOwnerKey(file, {})
      return {
        id: file.id,
        legacy: legacyEditorModelUri(file.filePath, owner),
        next: toEditorModelUri(file.filePath, owner)
      }
    })
    const mismatches: string[] = []
    let sharedPairs = 0
    for (const [index, a] of keyed.entries()) {
      for (const b of keyed.slice(index + 1)) {
        const sharedBefore = a.legacy === b.legacy
        sharedPairs += sharedBefore ? 1 : 0
        if (sharedBefore !== (a.next === b.next)) {
          mismatches.push(`${a.id} ~ ${b.id}`)
        }
      }
    }
    expect(mismatches).toEqual([])
    // Require real shared pairs so an entirely isolated fixture cannot pass parity vacuously.
    expect(sharedPairs).toBeGreaterThan(PATHS.length)
  })

  it('keeps sharing a model when an existing model key is passed back in', () => {
    for (const file of TABS) {
      const owner = getEditorModelOwnerKey(file, {})
      const uri = toEditorModelUri(file.filePath, owner)
      expect(toEditorModelUri(uri)).toBe(uri)
      expect(toEditorModelUri(uri, owner)).toBe(uri)
    }
  })
})
