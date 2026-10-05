import { expect, it } from 'vitest'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../shared/constants'
import type { OpenFile } from '@/store/slices/editor'
import {
  selectEditorExternalWatchTargets,
  type EditorExternalWatchTargetState
} from './editor-external-watch-targets'

function file(filePath: string, overrides: Partial<OpenFile> = {}): OpenFile {
  return {
    id: filePath,
    worktreeId: 'folder:local',
    filePath,
    relativePath: 'workspace-relative.md',
    language: 'markdown',
    mode: 'edit',
    isDirty: false,
    ...overrides
  }
}
function state(openFiles: OpenFile[]): EditorExternalWatchTargetState {
  return {
    openFiles,
    repos: [],
    worktreesByRepo: {},
    activeWorktreeId: null,
    settings: null,
    rightSidebarOpen: false,
    rightSidebarTab: 'explorer',
    rightSidebarExplorerView: 'files',
    gitStatusHugeByWorktree: {},
    sshConnectionStates: new Map(),
    folderWorkspaces: [
      {
        id: 'local',
        projectGroupId: 'group',
        name: 'Local',
        folderPath: '/repo/worktree',
        executionHostId: 'local',
        linkedTask: null,
        comment: '',
        isArchived: false,
        isUnread: false,
        isPinned: false,
        sortOrder: 0,
        lastActivityAt: 0,
        createdAt: 0,
        updatedAt: 0
      }
    ],
    projectGroups: [
      {
        id: 'group',
        name: 'Local',
        parentPath: '/repo',
        executionHostId: 'local',
        parentGroupId: null,
        createdFrom: 'manual',
        tabOrder: 0,
        isCollapsed: false,
        color: null,
        createdAt: 0,
        updatedAt: 0
      }
    ]
  }
}
const shallowRoots = (input: EditorExternalWatchTargetState) =>
  selectEditorExternalWatchTargets(input)
    .targets.filter((target) => target.shallow)
    .map((target) => target.worktreePath)

it('watches scratch, sibling and filesystem-root files without recursively watching their parent', () => {
  expect(
    shallowRoots(state([file('/tmp/scratch/plan.md'), file('/repo/notes.md'), file('/notes.md')]))
  ).toEqual(['/', '/repo', '/tmp/scratch'])
})

it('covers every open directory beyond eight and shares a directory within an owner', () => {
  const files = Array.from({ length: 12 }, (_, index) => file(`/tmp/${index}/notes.md`))
  files.push(file('/tmp/0/other.md'))
  expect(shallowRoots(state(files))).toHaveLength(12)
})

it('watches floating edit and preview files across directories without a workspace record', () => {
  expect(
    shallowRoots(
      state([
        file('/notes/first.md', { worktreeId: FLOATING_TERMINAL_WORKTREE_ID }),
        file('/drafts/second.md', {
          worktreeId: FLOATING_TERMINAL_WORKTREE_ID,
          mode: 'markdown-preview'
        })
      ])
    )
  ).toEqual(['/drafts', '/notes'])
})

it('keeps registered-root coverage and skips remote, untitled, relative and non-editor paths', () => {
  expect(
    shallowRoots(
      state([
        file('/repo/worktree/inside.md'),
        file('/tmp/runtime.md', { runtimeEnvironmentId: 'peer' }),
        file('/tmp/ssh.md', { externalSshTargetId: 'other-host' }),
        file('/tmp/draft.md', { isUntitled: true }),
        file('untitled.md'),
        file('/tmp/diff.md', { mode: 'diff' }),
        file('\\\\wsl.localhost\\Ubuntu\\notes.md')
      ])
    )
  ).toEqual([])
})

it('does not infer local execution from a runtime or unresolved folder stamp', () => {
  for (const executionHostId of ['runtime:peer', undefined] as const) {
    const input = state([file('/tmp/plan.md')])
    input.folderWorkspaces[0].executionHostId = executionHostId
    expect(shallowRoots(input)).toEqual([])
  }
})

it('keeps a stable snapshot when dirty state or same-directory tab order changes', () => {
  const first = selectEditorExternalWatchTargets(
    state([file('/tmp/notes.md'), file('/tmp/other.md')])
  )
  const second = selectEditorExternalWatchTargets(
    state([file('/tmp/other.md', { isDirty: true }), file('/tmp/notes.md')])
  )
  expect(second).toBe(first)
})

it('retains POSIX literal backslashes and the Windows drive-root separator', () => {
  expect(shallowRoots(state([file('/tmp/name\\literal.md')]))).toEqual(['/tmp'])
  expect(
    shallowRoots(state([file('C:\\notes.md', { worktreeId: FLOATING_TERMINAL_WORKTREE_ID })]))
  ).toEqual(['C:\\'])
})

it('watches explicitly opened outside files beneath normally ignored directory names', () => {
  expect(
    shallowRoots(state([file('/tmp/node_modules/notes.md'), file('/tmp/.git/notes.md')]))
  ).toEqual(['/tmp/.git', '/tmp/node_modules'])
})
