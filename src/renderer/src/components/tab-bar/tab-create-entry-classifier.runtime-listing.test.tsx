// @vitest-environment happy-dom
//
// Why: every other TabBarCreateEntry suite mocks useRuntimeFileListForWorktree, so the classifier
// has only ever been graded against hand-written RuntimeFileListState values. That is the same
// seam #21423 shipped a P0 through in the file explorer. This spec runs the classifier on the
// listing the real hook returns, mocking only the IPC boundary.

import { act, createElement } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../../shared/workspace-scope'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from '../quick-open-file-list'
import { getTabEntryOptions } from './tab-create-entry-classifier'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())
const cancelRuntimeFileListMock = vi.hoisted(() => vi.fn())
const searchRuntimeFilePathsMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: cancelRuntimeFileListMock,
  searchRuntimeFilePaths: searchRuntimeFilePathsMock
}))

const initialAppState = useAppStore.getInitialState()
const WORKSPACE_KEY = folderWorkspaceKey('local-workspace')
const roots: Root[] = []

function seedLocalWorkspace(): void {
  const group: ProjectGroup = {
    id: 'local-group',
    name: 'local-group',
    parentPath: '/local/proj',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
  const workspace: FolderWorkspace = {
    id: 'local-workspace',
    projectGroupId: 'local-group',
    name: 'local-workspace',
    folderPath: '/local/proj',
    connectionId: null,
    linkedTask: null,
    comment: '',
    isArchived: false,
    isUnread: false,
    isPinned: false,
    sortOrder: 1,
    lastActivityAt: 0,
    createdAt: 1,
    updatedAt: 1
  }
  const seeded: Partial<AppState> = {
    folderWorkspaces: [workspace],
    projectGroups: [group],
    repos: [],
    worktreesByRepo: {}
  }
  useAppStore.setState(seeded)
}

function HookProbe({
  onState,
  worktreeId
}: {
  onState: (state: RuntimeFileListState) => void
  worktreeId: string
}): null {
  onState(useRuntimeFileListForWorktree({ enabled: true, worktreeId }))
  return null
}

/** Render the real list hook and return every state it rendered, in order. */
async function renderFileList(): Promise<RuntimeFileListState[]> {
  const states: RuntimeFileListState[] = []
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(
      createElement(HookProbe, {
        worktreeId: WORKSPACE_KEY,
        onState: (state: RuntimeFileListState) => states.push(state)
      })
    )
  })
  return states
}

async function drainMicrotasks(): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

function latestState(states: RuntimeFileListState[]): RuntimeFileListState {
  const latest = states.at(-1)
  if (!latest) {
    throw new Error('the file list hook never rendered')
  }
  return latest
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json', 'src/main.ts'])
  cancelRuntimeFileListMock.mockReset()
  searchRuntimeFilePathsMock.mockReset().mockResolvedValue({ files: [], truncated: false })
  seedLocalWorkspace()
})

afterEach(async () => {
  for (const root of roots) {
    await act(async () => {
      root.unmount()
    })
  }
  roots.length = 0
  useAppStore.setState(initialAppState, true)
})

describe('tab entry options over the real runtime listing', () => {
  // A listing the hook fetched but hid would leave the entry stuck on its loading placeholder.
  it('does not report the settled listing as still loading', async () => {
    let resolveListing: (files: string[]) => void = () => {}
    listRuntimeFilesMock.mockImplementationOnce(
      () =>
        new Promise<string[]>((resolve) => {
          resolveListing = resolve
        })
    )
    const states = await renderFileList()
    const blockedIds = (fileList: RuntimeFileListState): string[] =>
      getTabEntryOptions('packages/app/package.json', fileList, 4)
        .filter((option) => option.classification.kind === 'blocked')
        .map((option) => option.id)

    // Pins that the settled assertion below is not vacuous: the pending listing does block.
    expect(blockedIds(latestState(states))).toContain('loading')

    await act(async () => {
      resolveListing(['packages/app/package.json', 'src/main.ts'])
    })
    await drainMicrotasks()

    expect(blockedIds(latestState(states))).not.toContain('loading')
  })
})
