// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from 'vitest'
import type { StoreApi } from 'zustand'
import type { AppState } from '@/store/types'
import type * as StoreListenerCensus from '@/store/diagnostics/store-listener-census'
import { act, cleanup, renderHook } from '@testing-library/react'
import { useAppStore } from '@/store'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { makeTab } from '@/store/terminals/terminal-tab.test-fixture'
import { replaceRecordEntries } from '@/store/keyed-record-transitions'
import { getResolvedExecutionHostIdForWorktree } from '@/lib/workspace/ownership/resolved-worktree-execution-host'
import { useTerminalWorkspaceFoundation } from '@/components/use-terminal-workspace-foundation'
import { useWorktreeJumpPaletteStoreState } from '@/components/worktree-jump/use-worktree-jump-palette-store-state'
import { getExistingContentWorktrees } from './existing-workspace-content'
import { installContentFleet } from './existing-workspace-content.perf.test-fixture'
import { createBumpWorktreeActivity } from '@/store/slices/worktrees/session/worktree-activity-bump'
import { createBrowserTabActions } from '@/store/slices/browser/tabs/browser-tab-actions'
import { createBrowserCloseActions } from '@/store/slices/browser/cleanup/browser-close-actions'
import { applyDetectedWorktreeUpdates } from '@/store/slices/worktrees/listing/detected-worktree-meta'
import { replaceDetectedWorktreeListing } from '@/store/slices/worktrees/listing/detected-worktree-publication'
import { findIndexedDetectedWorktreeRows } from '@/lib/workspace/ownership/worktree-runtime-owner-index'

const contentNotifications = vi.hoisted(() => ({ depth: 0 }))

vi.mock('@/store/diagnostics/store-listener-census', async (importOriginal) => {
  const actual = await importOriginal<typeof StoreListenerCensus>()
  return {
    ...actual,
    installStoreListenerCensus: (api: Pick<StoreApi<AppState>, 'subscribe'>) => {
      actual.installStoreListenerCensus(api)
      const subscribe = api.subscribe
      // Observe the inner API before hooks subscribe; captured slice setters notify it too.
      api.subscribe = (listener) =>
        subscribe((state, previous) => {
          contentNotifications.depth++
          try {
            listener(state, previous)
          } finally {
            contentNotifications.depth--
          }
        })
    }
  }
})

vi.mock('../../../../../shared/sidebar-inputs-switch', () => ({
  ORCA_SIDEBAR_INPUTS_IS_MAIN: false
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({
  callRuntimeRpc: vi.fn(async () => undefined)
}))

vi.mock('@/hooks/useSettingsNavigationMetadata', () => ({
  useSettingsNavigationMetadata: () => []
}))
vi.mock('@/store/plugins/catalog/plugin-contribution-catalog', () => ({
  usePluginCommands: () => []
}))
vi.mock('@/store/plugins/file-creation/plugin-new-files', () => ({
  usePluginNewFiles: () => []
}))

const initialState = useAppStore.getInitialState()
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  useAppStore.setState(initialState, true)
})

it.each([
  [100, 'repo::/99/.bare'],
  [1000, 'repo::/999/.bare']
] as const)(
  'bounds real raw and nonempty-bucket publications before warmed consumers among %i workspaces',
  (count, finalId) => {
    vi.stubGlobal('api', {
      worktrees: {
        updateMeta: vi.fn<typeof window.api.worktrees.updateMeta>().mockResolvedValue(null)
      }
    })
    let measuringAddressedLookups = false
    const isConsumerRead = () => contentNotifications.depth > 0 || measuringAddressedLookups
    let producerRowReads = 0
    let unrelatedConsumerRowReads = 0
    const rows = installContentFleet(count, (index) => {
      if (isConsumerRead() && index > 1) {
        unrelatedConsumerRowReads++
      } else if (!isConsumerRead()) {
        producerRowReads++
      }
    })
    const set = useAppStore.setState
    const bumpActivity = createBumpWorktreeActivity(set, useAppStore.getState)
    const browsers = createBrowserTabActions(set, useAppStore.getState)
    const closeBrowsers = createBrowserCloseActions(set, useAppStore.getState)
    const renders = { foundation: 0, owner: 0, active: 0, lingering: 0 }
    const foundation = renderHook(() => {
      renders.foundation++
      return useTerminalWorkspaceFoundation()
    })
    const owner = renderHook(() => {
      renders.owner++
      return useAppStore((state) => getResolvedExecutionHostIdForWorktree(state, 'repo::/0/.bare'))
    })
    const palette = renderHook(() => {
      renders.active++
      return useWorktreeJumpPaletteStoreState({ visible: true, lingering: false })
    })
    const lingering = renderHook(() => {
      renders.lingering++
      return useWorktreeJumpPaletteStoreState({ visible: false, lingering: true })
    })
    expect(palette.result.current.workspaces).toEqual([])
    expect(palette.result.current.contentWorkspaces).toHaveLength(count - 1)
    expect(foundation.result.current.workspaceSurfaces[0]).toEqual({
      id: 'repo::/0/.bare',
      path: '/0/.bare'
    })
    expect(owner.result.current).toBe('local')
    const surfaces = foundation.result.current.workspaceSurfaces
    const owners = palette.result.current.contentWorkspaces
    const lingeringOwners = lingering.result.current.contentWorkspaces
    const reset = () => {
      renders.foundation = renders.owner = renders.active = renders.lingering = 0
      unrelatedConsumerRowReads = producerRowReads = 0
    }
    reset()
    // Accepted notifications are measured after the real writer's updater finishes.
    act(() => bumpActivity('repo::/1/.bare'))
    expect(producerRowReads).toBeGreaterThan(0)
    expect(unrelatedConsumerRowReads).toBe(0)
    expect(renders).toEqual({ foundation: 0, owner: 0, active: 0, lingering: 0 })
    expect(foundation.result.current.workspaceSurfaces).toBe(surfaces)
    expect(palette.result.current.contentWorkspaces).toBe(owners)
    expect(lingering.result.current.contentWorkspaces).toBe(lingeringOwners)
    expect(
      findIndexedDetectedWorktreeRows(
        useAppStore.getState().detectedWorktreesByRepo,
        'repo::/1/.bare'
      )[0]
    ).toBe(useAppStore.getState().detectedWorktreesByRepo.repo.worktrees[1])
    reset()
    act(() =>
      set((state) => ({
        detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
          state.detectedWorktreesByRepo,
          'repo::/1/.bare',
          { isUnread: true },
          'local'
        )
      }))
    )
    expect(unrelatedConsumerRowReads).toBe(0)
    expect(renders).toEqual({ foundation: 0, owner: 0, active: 0, lingering: 0 })
    expect(palette.result.current.contentWorkspaces).toBe(owners)
    reset()
    // A distinct turn cannot hide a render in React's batching of the activity publication.
    act(() => useAppStore.setState({ sidebarWidth: initialState.sidebarWidth + 1 }))
    expect(renders).toEqual({ foundation: 0, owner: 0, active: 0, lingering: 0 })
    expect(unrelatedConsumerRowReads).toBe(0)

    reset()
    act(() =>
      set((state) => ({
        tabsByWorktree: replaceRecordEntries(state.tabsByWorktree, [
          [
            'repo::/0/.bare',
            state.tabsByWorktree['repo::/0/.bare'].map((tab) => ({
              ...tab,
              title: 'Renamed shell'
            }))
          ]
        ])
      }))
    )
    expect(renders.foundation).toBe(0)
    expect(renders.owner).toBe(0)
    expect(unrelatedConsumerRowReads).toBe(0)
    expect(foundation.result.current.workspaceSurfaces).toBe(surfaces)
    expect(palette.result.current.contentWorkspaces).toBe(owners)

    measuringAddressedLookups = true
    try {
      for (let iteration = 0; iteration < 20; iteration++) {
        expect(
          getResolvedExecutionHostIdForWorktree(useAppStore.getState(), 'repo::/0/.bare')
        ).toBe('local')
        expect(getExistingContentWorktrees(useAppStore.getState(), ['repo::/0/.bare'])[0]).toBe(
          rows[0]
        )
      }
    } finally {
      measuringAddressedLookups = false
    }
    expect(unrelatedConsumerRowReads).toBe(0)

    const entries = Object.entries
    let unrelatedEnumeratedBuckets = 0
    const enumeration = vi.spyOn(Object, 'entries').mockImplementation((object) => {
      const result = entries(object)
      if (isConsumerRead()) {
        for (const [workspaceId] of result) {
          if (workspaceId.startsWith('repo::/') && workspaceId !== 'repo::/0/.bare') {
            unrelatedEnumeratedBuckets++
          }
        }
      }
      return result
    })
    reset()
    let addedBrowserId = ''
    act(() => {
      addedBrowserId = browsers.createBrowserTab('repo::/0/.bare', 'https://example.test/another', {
        activate: false,
        executionHostId: 'local',
        sessionProfileId: null,
        targetGroupId: 'group:repo::/0/.bare'
      }).id
    })
    // Existing browser/unified buckets both stay nonempty: unchanged membership requires zero unrelated address enumeration.
    expect(unrelatedEnumeratedBuckets).toBe(0)
    expect(unrelatedConsumerRowReads).toBe(0)
    expect(renders.foundation).toBe(0)
    expect(renders.owner).toBe(0)
    expect(foundation.result.current.workspaceSurfaces).toBe(surfaces)
    expect(palette.result.current.contentWorkspaces).toBe(owners)
    expect(lingering.result.current.contentWorkspaces).toBe(lingeringOwners)
    expect(useAppStore.getState().browserTabsByWorktree['repo::/0/.bare']).toHaveLength(2)
    expect(
      useAppStore.getState().unifiedTabsByWorktree['repo::/0/.bare'].map((tab) => tab.entityId)
    ).toEqual(['browser:repo::/0/.bare', addedBrowserId])
    // The palette's browser result changes legitimately; its content-owner input does not.
    reset()
    unrelatedEnumeratedBuckets = 0
    act(() => closeBrowsers.closeBrowserTab(addedBrowserId, { preserveWorktreeSelection: true }))
    enumeration.mockRestore()
    expect(unrelatedEnumeratedBuckets).toBe(0)
    expect(unrelatedConsumerRowReads).toBe(0)
    expect(renders.foundation).toBe(0)
    expect(renders.owner).toBe(0)
    expect(palette.result.current.contentWorkspaces).toBe(owners)
    expect(lingering.result.current.contentWorkspaces).toBe(lingeringOwners)
    expect(
      useAppStore.getState().browserTabsByWorktree['repo::/0/.bare'].map((tab) => tab.id)
    ).toEqual(['browser:repo::/0/.bare'])
    expect(
      useAppStore.getState().unifiedTabsByWorktree['repo::/0/.bare'].map((tab) => tab.entityId)
    ).toEqual(['browser:repo::/0/.bare'])

    act(() =>
      set((state) => ({
        detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
          state.detectedWorktreesByRepo,
          'repo::/1/.bare',
          { displayName: 'Renamed original' },
          'local'
        )
      }))
    )
    expect(palette.result.current.contentWorkspaces[1].displayName).toBe('Renamed original')
    act(() => {
      const current = useAppStore.getState().detectedWorktreesByRepo
      set({
        detectedWorktreesByRepo: replaceDetectedWorktreeListing(current, 'repo', {
          ...current.repo,
          worktrees: current.repo.worktrees.map((row, index) =>
            index === 1 ? { ...row, path: '/relocated/.bare' } : row
          )
        })
      })
    })
    expect(foundation.result.current.workspaceSurfaces[1]).toEqual({
      id: 'repo::/1/.bare',
      path: '/relocated/.bare'
    })
    act(() =>
      set((state) => ({
        tabsByWorktree: replaceRecordEntries(state.tabsByWorktree, [
          [finalId, [makeTab({ id: 'new-content', worktreeId: finalId })]]
        ])
      }))
    )
    expect(palette.result.current.contentWorkspaces).toHaveLength(count)
    expect(foundation.result.current.workspaceSurfaces.at(-1)?.id).toBe(finalId)
    act(() =>
      set((state) => ({
        tabsByWorktree: replaceRecordEntries<AppState['tabsByWorktree'][string]>(
          state.tabsByWorktree,
          [['repo::/1/.bare', []]]
        ),
        browserTabsByWorktree: replaceRecordEntries<AppState['browserTabsByWorktree'][string]>(
          state.browserTabsByWorktree,
          [['repo::/1/.bare', []]]
        ),
        unifiedTabsByWorktree: replaceRecordEntries<AppState['unifiedTabsByWorktree'][string]>(
          state.unifiedTabsByWorktree,
          [['repo::/1/.bare', []]]
        )
      }))
    )
    expect(
      foundation.result.current.workspaceSurfaces.some((row) => row.id === 'repo::/1/.bare')
    ).toBe(false)
    expect(
      palette.result.current.contentWorkspaces.some((row) => row.id === 'repo::/1/.bare')
    ).toBe(false)
    expect(getExistingContentWorktrees(useAppStore.getState(), ['repo::/0/.bare'])[0]).toBe(rows[0])
    act(() => {
      const state = useAppStore.getState()
      set({
        repos: [
          ...state.repos,
          { ...state.repos[0], executionHostId: 'ssh:other', connectionId: 'other' }
        ],
        detectedWorktreesByRepo: applyDetectedWorktreeUpdates(
          state.detectedWorktreesByRepo,
          'repo::/0/.bare',
          { hostId: 'ssh:other' },
          'local'
        )
      })
    })
    expect(owner.result.current).toBeNull()
    expect(palette.result.current.contentWorkspaces[0].hostId).toBe('ssh:other')
    act(() => useAppStore.setState({ activeWorkspaceExecutionHostId: 'ssh:other' }))
    expect(owner.result.current).toBe('ssh:other')
    act(() => {
      const current = useAppStore.getState().detectedWorktreesByRepo
      set({
        detectedWorktreesByRepo: replaceDetectedWorktreeListing(current, 'repo', {
          ...current.repo,
          worktrees: current.repo.worktrees.map((row, index) =>
            index === 2 ? { ...row, id: 'repo::/renamed/.bare', path: '/renamed/.bare' } : row
          )
        })
      })
    })
    expect(
      foundation.result.current.workspaceSurfaces.some((row) => row.id === 'repo::/2/.bare')
    ).toBe(false)
    expect(
      findIndexedDetectedWorktreeRows(
        useAppStore.getState().detectedWorktreesByRepo,
        'repo::/renamed/.bare'
      )[0].path
    ).toBe('/renamed/.bare')
  }
)

it.each([100, 1000])(
  'does not read raw content owners while the palette is closed among %i rows',
  (count) => {
    let rowReads = 0
    const rows = Array.from({ length: count }, (_, index) => ({
      ...makeWorktree({
        id: `repo::/${index}/.bare`,
        repoId: 'repo',
        path: `/${index}/.bare`,
        hostId: 'local',
        isBare: true
      }),
      get id() {
        rowReads++
        return `repo::/${index}/.bare`
      },
      ownership: 'external' as const,
      selectedCheckout: false,
      visible: false
    }))
    useAppStore.setState(
      {
        ...initialState,
        worktreesByRepo: {},
        detectedWorktreesByRepo: {
          repo: { repoId: 'repo', authoritative: true, source: 'git', worktrees: rows }
        },
        tabsByWorktree: {
          'repo::/0/.bare': [makeTab({ id: 'saved-shell', worktreeId: 'repo::/0/.bare' })]
        }
      },
      true
    )
    const palette = renderHook(
      ({ visible }) => useWorktreeJumpPaletteStoreState({ visible, lingering: false }),
      {
        initialProps: { visible: true }
      }
    )
    expect(palette.result.current.contentWorkspaces.map((row) => row.id)).toEqual([
      'repo::/0/.bare'
    ])
    palette.rerender({ visible: false })
    rowReads = 0
    act(() => {
      useAppStore.setState({
        detectedWorktreesByRepo: {
          repo: { repoId: 'repo', authoritative: true, source: 'git', worktrees: rows.slice() }
        }
      })
    })
    expect(rowReads).toBe(0)
    expect(palette.result.current.contentWorkspaces).toEqual([])
    palette.rerender({ visible: true })
    expect(palette.result.current.contentWorkspaces.map((row) => row.id)).toEqual([
      'repo::/0/.bare'
    ])
  }
)
