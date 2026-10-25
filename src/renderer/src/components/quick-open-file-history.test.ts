import { beforeEach, expect, it, vi } from 'vitest'
const { owner } = vi.hoisted(() => {
  const owner: { current: { kind: string; connectionId?: string; environmentId?: string } } = {
    current: { kind: 'local' }
  }
  return { owner }
})
vi.mock('@/lib/worktree-operation-route', () => ({
  resolveWorktreeOperationRoute: () =>
    owner.current.kind === 'local'
      ? { executionHostId: 'local', runtimeEnvironmentId: null }
      : {
          executionHostId:
            owner.current.kind === 'ssh'
              ? `ssh:${owner.current.connectionId}`
              : `runtime:${owner.current.environmentId}`,
          runtimeEnvironmentId: owner.current.environmentId ?? null
        }
}))
import {
  recordQuickOpenFileVisit,
  quickOpenHistoryScope,
  readQuickOpenHistory
} from '@/lib/quick-open-file-history'
import type { AppState } from '@/store/types'
import type { OpenFile } from '@/store/slices/editor/types/open-file'

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: history reads only the known workspace lookup and mocked owner.
const state = {
  getKnownWorktreeById: (id: string) => ({ path: `/folder/${id}` })
} as unknown as AppState
function file(name: string, worktreeId = 'folder:one'): OpenFile {
  return {
    id: name,
    filePath: `/folder/${worktreeId}/${name}`,
    relativePath: name,
    worktreeId,
    mode: 'edit',
    language: 'text',
    isDirty: false
  }
}
beforeEach(() => {
  owner.current = { kind: 'local' }
})

it('records opens after closure and deduplicates visits in recency order', () => {
  recordQuickOpenFileVisit(state, file('a.ts'))
  recordQuickOpenFileVisit(state, file('b.ts'))
  recordQuickOpenFileVisit(state, file('a.ts'))
  expect(
    readQuickOpenHistory(quickOpenHistoryScope(state, 'folder:one', '/folder/folder:one'))
  ).toEqual(['a.ts', 'b.ts'])
})

it('isolates workspace, SSH host and paired runtime history', () => {
  const localScope = quickOpenHistoryScope(state, 'folder:two', '/folder/folder:two')
  recordQuickOpenFileVisit(state, file('local.ts', 'folder:two'))
  owner.current = { kind: 'ssh', connectionId: 'host-a' }
  const sshScope = quickOpenHistoryScope(state, 'folder:two', '/folder/folder:two')
  recordQuickOpenFileVisit(state, file('remote.ts', 'folder:two'))
  owner.current = { kind: 'ssh', connectionId: 'host-b' }
  expect(
    readQuickOpenHistory(quickOpenHistoryScope(state, 'folder:two', '/folder/folder:two'))
  ).toEqual([])
  owner.current = { kind: 'runtime', environmentId: 'paired-a' }
  expect(
    readQuickOpenHistory(quickOpenHistoryScope(state, 'folder:two', '/folder/folder:two'))
  ).toEqual([])
  expect(readQuickOpenHistory(localScope)).toEqual(['local.ts'])
  expect(readQuickOpenHistory(sshScope)).toEqual(['remote.ts'])
  expect(
    readQuickOpenHistory(quickOpenHistoryScope(state, 'folder:other', '/folder/folder:other'))
  ).toEqual([])
})

it('bounds retained files and workspaces without losing the newest visits', () => {
  for (let i = 0; i < 150; i++) {
    recordQuickOpenFileVisit(state, file(`file-${i}.ts`, 'bounded-files'))
  }
  const paths = readQuickOpenHistory(
    quickOpenHistoryScope(state, 'bounded-files', '/folder/bounded-files')
  )
  expect(paths).toHaveLength(100)
  expect(paths[0]).toBe('file-149.ts')
  for (let i = 0; i < 70; i++) {
    recordQuickOpenFileVisit(state, file('latest.ts', `bounded-owner-${i}`))
  }
  expect(
    readQuickOpenHistory(quickOpenHistoryScope(state, 'bounded-owner-0', '/folder/bounded-owner-0'))
  ).toEqual([])
  expect(
    readQuickOpenHistory(
      quickOpenHistoryScope(state, 'bounded-owner-69', '/folder/bounded-owner-69')
    )
  ).toEqual(['latest.ts'])
})

it('ignores unowned and temporary files', () => {
  const scope = quickOpenHistoryScope(state, 'invalid-history', '/folder/invalid-history')
  recordQuickOpenFileVisit(state, { ...file('draft.ts', 'invalid-history'), isUntitled: true })
  recordQuickOpenFileVisit(state, { ...file('diff.ts', 'invalid-history'), mode: 'diff' })
  expect(readQuickOpenHistory(scope)).toEqual([])
})

it('does not record a loaded file under a replacement host owner', () => {
  const stale: OpenFile = {
    ...file('stale.ts', 'owner-replacement'),
    operationProvenance: {
      ownershipProjection: 'explicit',
      generation: {
        route: { executionHostId: 'ssh:old-host', runtimeEnvironmentId: null },
        runtimeConnectionGeneration: null,
        runtimePairingRevision: undefined,
        runtimeSshGeneration: null,
        nestedSshGeneration: null,
        directSshGeneration: 1
      }
    }
  }
  owner.current = { kind: 'ssh', connectionId: 'new-host' }
  recordQuickOpenFileVisit(state, stale)
  expect(
    readQuickOpenHistory(
      quickOpenHistoryScope(state, 'owner-replacement', '/folder/owner-replacement')
    )
  ).toEqual([])
})
