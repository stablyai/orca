import { describe, expect, it } from 'vitest'
import { normalizeRuntimePathForComparison } from '../../../shared/cross-platform-path'
import { wslMoveRendererRewriteScope } from '../../../shared/wsl-move/wsl-move-renderer-rewrite-scope'
import { buildFileViewPreferenceKey } from '../components/editor/file-view-preference-storage'
import {
  hostCsvColumnWidthsKey,
  hostFileViewPreferenceKey,
  hostNotebookEnvironment,
  hostQuickOpenHistoryScope
} from './wsl-move-renderer-store-keys'

const scope = wslMoveRendererRewriteScope({
  distro: 'Ubuntu',
  scopeRepoIds: ['repo-1'],
  scopeFolderWorkspaceIds: ['folder-1'],
  destinationHostId: 'runtime:wsl-env',
  destinationEnvironmentId: 'wsl-env',
  scopeRootPaths: ['/home/u/proj', '/home/u/notes']
})

const UNC_ROOT = '\\\\wsl.localhost\\Ubuntu\\home\\u\\proj'
const LOCAL_ID = `repo-1::${UNC_ROOT}`
const HOST_ID = 'repo-1::/home/u/proj'
const localRoute = { executionHostId: 'local', runtimeEnvironmentId: null }
const hostRoute = { executionHostId: 'runtime:wsl-env', runtimeEnvironmentId: 'wsl-env' }

describe('WSL move renderer rewrite scope', () => {
  it('maps a moved worktree id, either UNC spelling and its workspace key', () => {
    expect(scope.hostWorktreeId(LOCAL_ID)).toBe(HOST_ID)
    expect(scope.hostWorktreeId('repo-1::\\\\wsl$\\ubuntu\\home\\u\\proj')).toBe(HOST_ID)
    expect(scope.hostWorktreeId(`worktree:${LOCAL_ID}`)).toBe(`worktree:${HOST_ID}`)
    expect(scope.hostWorktreeId('folder:folder-1')).toBe('folder:folder-1')
  })

  it('leaves unmoved repos, other distros and host ids alone', () => {
    expect(scope.hostWorktreeId(`repo-2::${UNC_ROOT}`)).toBeNull()
    expect(scope.hostWorktreeId('repo-1::\\\\wsl.localhost\\Debian\\home\\u\\proj')).toBeNull()
    expect(scope.hostWorktreeId(HOST_ID)).toBeNull()
    expect(scope.hostWorktreeId('folder:folder-2')).toBeNull()
  })
})

describe('WSL move renderer store keys', () => {
  it('re-keys a moved quick-open history for the host, once', () => {
    const local = JSON.stringify([
      localRoute,
      LOCAL_ID,
      normalizeRuntimePathForComparison(UNC_ROOT)
    ])
    const host = hostQuickOpenHistoryScope(local, scope)
    expect(host).toBe(JSON.stringify([hostRoute, HOST_ID, '/home/u/proj']))
    // The host's own key maps to nothing, so a re-run adds nothing.
    expect(hostQuickOpenHistoryScope(host ?? '', scope)).toBeNull()
  })

  it('leaves quick-open histories of other hosts and unmoved repos alone', () => {
    const root = normalizeRuntimePathForComparison(UNC_ROOT)
    const ssh = { executionHostId: 'ssh:box', runtimeEnvironmentId: null }
    expect(hostQuickOpenHistoryScope(JSON.stringify([ssh, LOCAL_ID, root]), scope)).toBeNull()
    expect(
      hostQuickOpenHistoryScope(JSON.stringify([localRoute, `repo-2::${UNC_ROOT}`, root]), scope)
    ).toBeNull()
    expect(hostQuickOpenHistoryScope('not json', scope)).toBeNull()
  })

  it('re-keys a moved file view preference and its CSV wrapper', () => {
    const local = buildFileViewPreferenceKey({
      worktreeId: LOCAL_ID,
      filePath: `${UNC_ROOT}\\data.csv`
    })
    const host = buildFileViewPreferenceKey({
      worktreeId: HOST_ID,
      runtimeEnvironmentId: 'wsl-env',
      filePath: '/home/u/proj/data.csv'
    })
    expect(hostFileViewPreferenceKey(local, scope)).toBe(host)
    expect(hostFileViewPreferenceKey(host, scope)).toBeNull()
    expect(hostCsvColumnWidthsKey(JSON.stringify([local, ',']), scope)).toBe(
      JSON.stringify([host, ','])
    )
  })

  it('maps a moved folder workspace preference by path only', () => {
    const local = buildFileViewPreferenceKey({
      worktreeId: 'folder:folder-1',
      filePath: '\\\\wsl.localhost\\Ubuntu\\home\\u\\notes\\a.pdf'
    })
    expect(hostFileViewPreferenceKey(local, scope)).toBe(
      buildFileViewPreferenceKey({
        worktreeId: 'folder:folder-1',
        runtimeEnvironmentId: 'wsl-env',
        filePath: '/home/u/notes/a.pdf'
      })
    )
  })

  it('leaves file view preferences of runtime, SSH and unmoved workspaces alone', () => {
    const filePath = `${UNC_ROOT}\\a.pdf`
    for (const key of [
      buildFileViewPreferenceKey({ worktreeId: LOCAL_ID, runtimeEnvironmentId: 'other', filePath }),
      buildFileViewPreferenceKey({ worktreeId: LOCAL_ID, externalSshTargetId: 'box', filePath }),
      buildFileViewPreferenceKey({ worktreeId: `repo-2::${UNC_ROOT}`, filePath }),
      buildFileViewPreferenceKey({ worktreeId: 'folder:folder-2', filePath })
    ]) {
      expect(hostFileViewPreferenceKey(key, scope)).toBeNull()
    }
  })

  it('carries a notebook interpreter in the distro, inside a moved project only', () => {
    const venv = { path: `${UNC_ROOT}\\.venv\\bin\\python`, name: '.venv' }
    expect(hostNotebookEnvironment(`${UNC_ROOT}\\nb.ipynb`, venv, scope)).toEqual([
      '/home/u/proj/nb.ipynb',
      { path: '/home/u/proj/.venv/bin/python', name: '.venv' }
    ])
    // A Windows interpreter cannot run on the host.
    expect(
      hostNotebookEnvironment(
        `${UNC_ROOT}\\nb.ipynb`,
        { path: 'C:\\Python\\python.exe', name: 'python' },
        scope
      )
    ).toBeNull()
    // Same distro, but not a moved project's directory.
    expect(
      hostNotebookEnvironment('\\\\wsl.localhost\\Ubuntu\\home\\u\\other\\nb.ipynb', venv, scope)
    ).toBeNull()
    expect(hostNotebookEnvironment('/home/u/proj/nb.ipynb', venv, scope)).toBeNull()
  })
})
