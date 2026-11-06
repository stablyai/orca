import { expect, it } from 'vitest'
import { resolveQualifiedFolderWorkspaceResult } from './folder-workspace-execution-host'
import { createFolderWorkspaceHostIndex } from './folder-workspace-host-index'
import { collectionVisits } from './collection-visits.test-fixture'

const group = (
  id: string,
  extra: { parentGroupId?: string; connectionId?: string; executionHostId?: string } = {}
) => ({ id, parentGroupId: null, connectionId: null, ...extra })
const folder = (
  id: string,
  projectGroupId: string,
  extra: { folderPath?: string; connectionId?: string; executionHostId?: string } = {}
) => ({ id, projectGroupId, folderPath: '/work', ...extra })

// Every shape the shared resolver distinguishes: row, group and inherited pins; group repos that
// agree, mix or differ from a scope connection; path-only repos; runtime-nested SSH; duplicate
// folder and group rows; a parent cycle; and a row without a path.
const catalog = {
  projectGroups: [
    group('pinned-root', { executionHostId: 'ssh:pinned' }),
    group('pinned-child', { parentGroupId: 'pinned-root' }),
    group('connected', { connectionId: 'conn' }),
    group('runtime', { executionHostId: 'runtime:env', connectionId: 'nested' }),
    group('split', { executionHostId: 'ssh:one' }),
    group('split', { executionHostId: 'ssh:two' }),
    group('mixed-parent'),
    group('mixed-child', { parentGroupId: 'mixed-parent' }),
    group('ssh-only'),
    group('empty'),
    group('cycle-a', { parentGroupId: 'cycle-b' }),
    group('cycle-b', { parentGroupId: 'cycle-a' }),
    // A ring with a branch hanging below it: every member reaches the branch's repo.
    group('ring-x', { parentGroupId: 'ring-y' }),
    group('ring-y', { parentGroupId: 'ring-x' }),
    group('ring-branch', { parentGroupId: 'ring-y' })
  ],
  repos: [
    { path: '/elsewhere/a', projectGroupId: 'pinned-child' },
    { path: '/elsewhere/b', projectGroupId: 'connected', connectionId: 'conn' },
    { path: '/elsewhere/c', projectGroupId: 'connected' },
    { path: '/elsewhere/d', projectGroupId: 'mixed-parent' },
    { path: '/elsewhere/e', projectGroupId: 'mixed-child', executionHostId: 'ssh:remote' },
    { path: '/elsewhere/f', projectGroupId: 'ssh-only', connectionId: 'remote' },
    { path: '/elsewhere/g', projectGroupId: 'cycle-b', executionHostId: 'ssh:remote' },
    { path: '/work/inside', connectionId: 'remote' },
    { path: '/work/runtime', executionHostId: 'runtime:env', connectionId: 'nested' },
    { path: '/work' },
    { path: '/elsewhere/h', projectGroupId: 'ring-branch', connectionId: 'remote' },
    { path: 'C:\\Work\\Chat\\sub', connectionId: 'remote' },
    { path: '\\\\wsl$\\Ubuntu\\home\\Me\\proj', connectionId: 'remote' },
    { path: '//wsl.localhost/Ubuntu/home/me/other' }
  ],
  folderWorkspaces: [
    folder('row-pinned', 'empty', { executionHostId: 'ssh:row' }),
    folder('row-connection', 'empty', { connectionId: 'remote' }),
    folder('row-connection-mixed', 'mixed-parent', { connectionId: 'remote' }),
    folder('inherits-pin', 'pinned-child'),
    folder('own-pin', 'pinned-root'),
    folder('connected', 'connected'),
    folder('runtime', 'runtime'),
    folder('split', 'split'),
    folder('mixed', 'mixed-parent'),
    folder('mixed-child', 'mixed-child'),
    folder('ssh-only', 'ssh-only'),
    folder('path-only', 'empty'),
    folder('path-only-elsewhere', 'empty', { folderPath: '/nowhere' }),
    folder('no-path', 'empty', { folderPath: undefined }),
    folder('no-path-pinned', 'empty', { folderPath: undefined, executionHostId: 'local' }),
    folder('cycle', 'cycle-a'),
    folder('twice', 'ssh-only'),
    folder('twice', 'empty', { folderPath: '/nowhere' }),
    folder('ungrouped', 'missing-group'),
    folder('ring-x', 'ring-x'),
    folder('ring-y', 'ring-y'),
    folder('ring-branch', 'ring-branch'),
    // One Windows directory spelled three ways, and a sibling that only shares a prefix.
    folder('windows', 'empty', { folderPath: 'C:\\Work\\Chat' }),
    folder('windows-slashes', 'empty', { folderPath: 'c:/work/chat/' }),
    folder('windows-case', 'empty', { folderPath: 'C:\\WORK\\Chat\\' }),
    folder('windows-sibling', 'empty', { folderPath: 'C:\\Work\\Chatter' }),
    // WSL server and distro spellings fold; the Linux tail's case does not.
    folder('wsl', 'empty', { folderPath: '\\\\wsl$\\Ubuntu\\home\\Me' }),
    folder('wsl-alias', 'empty', { folderPath: '//wsl.localhost/ubuntu/home/Me' }),
    folder('wsl-other-case', 'empty', { folderPath: '//wsl.localhost/Ubuntu/home/me' })
  ]
}

it('decides every folder exactly as the scalar resolver does, for any required host', () => {
  const resolve = createFolderWorkspaceHostIndex(catalog)
  const ids = [...new Set(catalog.folderWorkspaces.map((row) => row.id)), 'absent']
  for (const required of [undefined, 'local', 'ssh:remote', 'runtime:env'] as const) {
    for (const id of ids) {
      expect([id, required, resolve(id, required)]).toEqual([
        id,
        required,
        resolveQualifiedFolderWorkspaceResult(catalog, id, required)
      ])
    }
  }
})

it('keeps literal containment boundaries, root and host semantics for unusual saved paths', () => {
  const paths = [
    '/',
    '//',
    'C:\\',
    '\\\\server\\share',
    '/a',
    '/ab',
    '/a/.',
    '/a/..',
    '/a/b',
    '/a/./b',
    '/a/../b',
    '/a\\b',
    '/caf\u00e9',
    '//wsl.localhost/Ubuntu/home/Me',
    '//wsl.localhost/Ubuntu/home/me'
  ]
  const state = {
    projectGroups: [group('empty')],
    folderWorkspaces: paths.map((folderPath, i) => folder(`path-${i}`, 'empty', { folderPath })),
    repos: [
      { path: '/a/b/leaf', connectionId: 'first' },
      { path: '/a/b/leaf', connectionId: 'second' },
      { path: '/ab/leaf', connectionId: 'sibling' },
      { path: '/a/./b/leaf', connectionId: 'dots' },
      { path: '/a/../b/leaf', connectionId: 'parent' },
      { path: '/a\\b/file', connectionId: 'backslash' },
      { path: '/cafe\u0301/leaf', connectionId: 'unicode' },
      { path: 'c:/root/leaf', connectionId: 'drive' },
      { path: '\\\\server\\share\\leaf', connectionId: 'unc' },
      { path: '\\\\wsl$\\Ubuntu\\home\\Me\\leaf', connectionId: 'wsl-upper' },
      { path: '//wsl.localhost/ubuntu/home/me/leaf', connectionId: 'wsl-lower' },
      { path: '' },
      { path: '//' }
    ]
  }
  for (const repos of [state.repos, state.repos.toReversed()]) {
    const current = { ...state, repos }
    const resolve = createFolderWorkspaceHostIndex(current)
    for (const row of current.folderWorkspaces) {
      expect(resolve(row.id)).toEqual(resolveQualifiedFolderWorkspaceResult(current, row.id))
    }
  }
})

it('shares a populated containment subtree without enumerating it for each query', () => {
  const work: number[] = []
  for (const n of [20, 200]) {
    const state = {
      projectGroups: [group('empty')],
      folderWorkspaces: Array.from({ length: n }, (_, i) => folder(`folder-${i}`, 'empty')),
      repos: Array.from({ length: n }, (_, i) => ({
        path: `/work/leaf-${i}`,
        connectionId: 'remote'
      }))
    }
    const measured = collectionVisits(() => {
      const resolve = createFolderWorkspaceHostIndex(state)
      return state.folderWorkspaces.map((row) => resolve(row.id))
    })
    expect(measured.value).toEqual(
      state.folderWorkspaces.map((row) => resolveQualifiedFolderWorkspaceResult(state, row.id))
    )
    // One catalog/character pass, plus one fixed folder/group decision and root walk per query.
    const characters =
      state.repos.reduce((sum, repo) => sum + repo.path.length, 0) + n * '/work'.length
    expect(measured.visits + measured.lookups).toBeLessThanOrEqual(4 * (characters + 2 * n))
    work.push(measured.visits + measured.lookups)
  }
  expect(work[1]).toBeLessThanOrEqual(12 * work[0])
})

it('reads each repo path once for every spelling of a directory', () => {
  let reads = 0
  const repos = catalog.repos.map((repo) => {
    const counted = { ...repo }
    Object.defineProperty(counted, 'path', {
      enumerable: true,
      get: () => {
        reads++
        return repo.path
      }
    })
    return counted
  })
  const resolve = createFolderWorkspaceHostIndex({ ...catalog, repos })
  const answers = ['windows', 'windows-slashes', 'windows-case', 'wsl', 'wsl-alias'].map((id) =>
    resolve(id)
  )
  expect(answers.map((answer) => answer.kind === 'selected' && answer.value.hostId)).toEqual(
    Array(5).fill('ssh:remote')
  )
  expect(resolve('wsl-other-case')).toMatchObject({ kind: 'selected', value: { hostId: 'local' } })
  expect(reads).toBe(repos.length)
})
