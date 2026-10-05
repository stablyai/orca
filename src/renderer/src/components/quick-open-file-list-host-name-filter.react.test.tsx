// @vitest-environment happy-dom

import { act, createElement, useEffect } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { FolderWorkspace } from '../../../shared/folder-workspace-types'
import type { ProjectGroup } from '../../../shared/project-group-types'
import { folderWorkspaceKey } from '../../../shared/workspace-scope'
import { QUICK_OPEN_LISTING_MAX_RESULTS } from '../../../shared/quick-open-listing-limits'
import { useAppStore } from '@/store'
import { useRuntimeFileListForWorktree, type RuntimeFileListState } from './quick-open-file-list'

const listRuntimeFilesMock = vi.hoisted(() => vi.fn())

vi.mock('@/runtime/runtime-file-client', () => ({
  listRuntimeFiles: listRuntimeFilesMock,
  cancelRuntimeFileList: vi.fn(),
  searchRuntimeFilePaths: vi.fn()
}))

const initialAppState = useAppStore.getInitialState()
const roots: Root[] = []

function makeProjectGroup(): ProjectGroup {
  return {
    id: 'group-1',
    name: 'Platform',
    parentPath: '/srv/platform',
    connectionId: null,
    parentGroupId: null,
    createdFrom: 'folder-scan',
    tabOrder: 0,
    isCollapsed: false,
    color: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function makeFolderWorkspace(): FolderWorkspace {
  return {
    id: 'folder-workspace-1',
    projectGroupId: 'group-1',
    name: 'Platform workspace',
    folderPath: '/srv/platform',
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
}

type ProbeProps = {
  enabled: boolean
  onState: (state: RuntimeFileListState) => void
  query?: string
  hostFilterWhenCapped?: boolean
  worktreeId: string | null
}

function HookProbe({ onState, ...args }: ProbeProps): null {
  const state = useRuntimeFileListForWorktree(args)
  useEffect(() => {
    onState(state)
  })
  return null
}

async function flushEffects(): Promise<void> {
  await act(async () => {
    await Promise.resolve()
    await Promise.resolve()
  })
}

async function waitForListRuntimeFilesCall(): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await flushEffects()
    if (listRuntimeFilesMock.mock.calls.length > 0) {
      return
    }
  }
  throw new Error('listRuntimeFiles was not called')
}

async function renderProbe(args: ProbeProps): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  roots.push(root)
  await act(async () => {
    root.render(createElement(HookProbe, args))
  })
  await flushEffects()
  return root
}

beforeEach(() => {
  useAppStore.setState(initialAppState, true)
  listRuntimeFilesMock.mockReset().mockResolvedValue(['packages/app/package.json'])
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

describe('useRuntimeFileListForWorktree host name filter', () => {
  it('re-lists a capped local workspace with the name filter applied on the host', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    })
    listRuntimeFilesMock
      .mockResolvedValueOnce(
        Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `src/file-${i}.ts`)
      )
      .mockResolvedValueOnce(['ios/AppDelegate.swift'])
    const states: RuntimeFileListState[] = []

    try {
      await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'AppDelegate',
        hostFilterWhenCapped: true,
        worktreeId: folderWorkspaceKey('folder-workspace-1')
      })
      await flushEffects()
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()

      expect(listRuntimeFilesMock).toHaveBeenCalledTimes(2)
      expect(listRuntimeFilesMock.mock.calls[0][1]).not.toHaveProperty('nameFilter')
      expect(listRuntimeFilesMock.mock.calls[1][1]).toMatchObject({ nameFilter: 'appdelegate' })
      expect(states.at(-1)).toMatchObject({
        files: ['ios/AppDelegate.swift'],
        loading: false,
        truncated: false
      })
    } finally {
      vi.useRealTimers()
    }
  })

  it('filters an uncapped local listing in the renderer without a host re-list', async () => {
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    })

    await renderProbe({
      enabled: true,
      onState: () => {},
      query: 'package',
      hostFilterWhenCapped: true,
      worktreeId: folderWorkspaceKey('folder-workspace-1')
    })
    await waitForListRuntimeFilesCall()
    await flushEffects()

    expect(listRuntimeFilesMock).toHaveBeenCalledTimes(1)
    expect(listRuntimeFilesMock.mock.calls[0][1]).not.toHaveProperty('nameFilter')
  })
  it('falls back to the capped listing and stops re-listing after a host filter failure', async () => {
    vi.useFakeTimers()
    useAppStore.setState({
      folderWorkspaces: [makeFolderWorkspace()],
      projectGroups: [makeProjectGroup()],
      repos: [],
      worktreesByRepo: {}
    })
    const capped = Array.from({ length: QUICK_OPEN_LISTING_MAX_RESULTS }, (_, i) => `f-${i}.ts`)
    listRuntimeFilesMock.mockImplementation(async (_context, args: { nameFilter?: string }) => {
      if (args.nameFilter) {
        throw new Error('rg list timed out')
      }
      return capped
    })
    const states: RuntimeFileListState[] = []
    const workspaceKey = folderWorkspaceKey('folder-workspace-1')

    try {
      const root = await renderProbe({
        enabled: true,
        onState: (state) => states.push(state),
        query: 'f-1',
        hostFilterWhenCapped: true,
        worktreeId: workspaceKey
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()
      await act(async () => {
        root.render(
          createElement(HookProbe, {
            enabled: true,
            onState: (state: RuntimeFileListState) => states.push(state),
            query: 'f-2',
            hostFilterWhenCapped: true,
            worktreeId: workspaceKey
          })
        )
      })
      await act(async () => vi.advanceTimersByTimeAsync(120))
      await flushEffects()

      const nameFilters = listRuntimeFilesMock.mock.calls.map((call) => call[1].nameFilter)
      expect(nameFilters.filter(Boolean)).toEqual(['f-1'])
      expect(states.at(-1)).toMatchObject({ files: capped, loadError: null, truncated: true })
    } finally {
      vi.useRealTimers()
    }
  })
})
