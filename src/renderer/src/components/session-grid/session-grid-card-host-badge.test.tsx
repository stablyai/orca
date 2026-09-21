// @vitest-environment happy-dom
import {
  makeRepo as makeGridTestRepo,
  makeWorktree as makeGridTestWorktree
} from '@/components/worktree-jump-palette-test-fixtures'
import { makeTerminalTab as makeGridTestTerminalTab } from '@/store/slices/worktrees-slice-test-fixtures'

import '@testing-library/jest-dom/vitest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as ReactVirtual from '@tanstack/react-virtual'
import { cleanup, render } from '@testing-library/react'
import { useAppStore } from '@/store'
import SessionsGridPage from './SessionsGridPage'
import { livePtyIdsFor } from './session-grid-test-live-ptys'
import { dashboardHostTooltipLabel } from '../dashboard-popout/DashboardHostBadge'
import type { TerminalTab } from '../../../../shared/terminal-tab-types'

// happy-dom lays nothing out, so the real virtualizer would report an empty range.
vi.mock('@tanstack/react-virtual', async (importOriginal) => ({
  ...(await importOriginal<typeof ReactVirtual>()),
  useVirtualizer: (options: { count: number; estimateSize: (index: number) => number }) => ({
    getVirtualItems: () =>
      Array.from({ length: options.count }, (_, index) => ({
        index,
        key: index,
        start: index * options.estimateSize(index),
        size: options.estimateSize(index)
      })),
    getTotalSize: () => options.count * options.estimateSize(0),
    measure: () => {}
  })
}))
vi.mock('../dashboard-popout/AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({ ptyId }: { ptyId: string }) => <div data-pty-id={ptyId} />
}))

const initialState = useAppStore.getInitialState()

/** Located by attribute, never by text: the app runs under the system locale. */
function hostBadge(tabId: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(`[data-tab-id="${tabId}"] [data-dashboard-host-badge]`)
}

function seed(): void {
  const tabsByWorktree: Record<string, TerminalTab[]> = {
    'wt-remote': [
      makeGridTestTerminalTab({
        customTitle: null,
        color: null,
        sortOrder: 0,
        id: 'tab-remote',
        ptyId: 'pty-r',
        worktreeId: 'wt-remote',
        title: 'Remote',
        createdAt: 1
      })
    ],
    'wt-local': [
      makeGridTestTerminalTab({
        customTitle: null,
        color: null,
        sortOrder: 0,
        id: 'tab-local',
        ptyId: 'pty-l',
        worktreeId: 'wt-local',
        title: 'Local',
        createdAt: 2
      })
    ],
    'wt-runtime': [
      makeGridTestTerminalTab({
        customTitle: null,
        color: null,
        sortOrder: 0,
        id: 'tab-runtime',
        ptyId: 'pty-rt',
        worktreeId: 'wt-runtime',
        title: 'Paired',
        createdAt: 3
      })
    ]
  }
  useAppStore.setState({
    activeView: 'sessions',
    activeSessionGridTabId: null,
    sessionsGridPreset: '2x2',
    sessionsGridZoom: 1,
    sessionsGridShowEmpty: false,
    sessionsGridFilter: 'all',
    sessionsGridStateFilter: 'all',
    sessionsGridTabOrder: [],
    sessionsGridHiddenTabIds: [],
    repos: [
      makeGridTestRepo({
        id: 'repo-remote',
        displayName: 'orca',
        path: '/srv/orca',
        connectionId: 'box'
      }),
      makeGridTestRepo({ id: 'repo-local', displayName: 'sytio', path: '/code/sytio' }),
      makeGridTestRepo({ id: 'repo-runtime', displayName: 'studio-checkout', path: '/w/studio' })
    ],
    worktreesByRepo: {
      'repo-remote': [
        makeGridTestWorktree('grid-fixture', '', {
          branch: '',
          id: 'wt-remote',
          repoId: 'repo-remote',
          displayName: 'orca',
          path: '/srv/orca'
        })
      ],
      'repo-local': [
        makeGridTestWorktree('grid-fixture', '', {
          branch: '',
          id: 'wt-local',
          repoId: 'repo-local',
          displayName: 'sytio',
          path: '/code/sytio'
        })
      ],
      'repo-runtime': [
        makeGridTestWorktree('grid-fixture', '', {
          branch: '',
          id: 'wt-runtime',
          repoId: 'repo-runtime',
          displayName: 'studio-checkout',
          path: '/w/studio',
          hostId: 'runtime:env-1'
        })
      ]
    },
    folderWorkspaces: [],
    projectGroups: [],
    sshTargetLabels: new Map([['box', 'build box']]),
    runtimeEnvironments: [
      {
        id: 'env-1',
        name: 'studio',
        createdAt: 0,
        updatedAt: 0,
        lastUsedAt: null,
        runtimeId: null,
        endpoints: [],
        preferredEndpointId: 'test'
      }
    ],
    tabsByWorktree,
    ptyIdsByTabId: livePtyIdsFor(tabsByWorktree),
    terminalLayoutsByTabId: {},
    agentStatusByPaneKey: {},
    unreadTerminalTabs: {},
    unreadAgentCompletionPanes: {}
  })
}

describe('session grid host badge', () => {
  beforeEach(() => {
    // Staged mounting admits one terminal per frame; run the frames synchronously.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0)
      return 0
    })
    vi.stubGlobal('cancelAnimationFrame', () => {})
    seed()
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    useAppStore.setState(initialState, true)
  })

  it('marks the card running on an SSH host and leaves the local one unmarked', () => {
    render(<SessionsGridPage />)

    expect(hostBadge('tab-remote')).toHaveAttribute('data-dashboard-host-badge', 'ssh')
    expect(hostBadge('tab-local')).toBeNull()
  })

  it('marks a card on a paired runtime remote, not SSH', () => {
    render(<SessionsGridPage />)

    expect(hostBadge('tab-runtime')).toHaveAttribute('data-dashboard-host-badge', 'remote')
    expect(hostBadge('tab-runtime')).toHaveAttribute(
      'aria-label',
      dashboardHostTooltipLabel({
        hostKind: 'remote',
        executionHostId: 'runtime:env-1',
        hostLabel: 'studio'
      })!
    )
  })

  it('names the host with the badge’s own copy, not a string of the grid’s', () => {
    render(<SessionsGridPage />)

    expect(hostBadge('tab-remote')).toHaveAttribute(
      'aria-label',
      dashboardHostTooltipLabel({
        hostKind: 'ssh',
        executionHostId: 'ssh:box',
        hostLabel: 'build box'
      })!
    )
  })
})
