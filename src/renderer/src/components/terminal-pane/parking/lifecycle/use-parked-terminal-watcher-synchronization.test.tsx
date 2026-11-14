// @vitest-environment happy-dom
import { memo } from 'react'
import { render } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import type { TerminalTab } from '../../../../../../shared/workspace-layout/terminal-tab-types'

vi.mock('../output-watchers/terminal-parked-tab-watchers', () => ({
  syncParkedTerminalTabWatchers: vi.fn()
}))
vi.mock('../output-watchers/terminal-parked-watcher-registry', () => ({
  disposeParkedTerminalWatchersForWorktree: vi.fn()
}))

import { syncParkedTerminalTabWatchers } from '../output-watchers/terminal-parked-tab-watchers'
import { useParkedTerminalWatcherSynchronization } from './use-parked-terminal-watcher-synchronization'

const WORKTREE_ID = 'wt-1'

type HostProps = {
  terminalTabs: readonly TerminalTab[]
  parkedTabIds: ReadonlySet<string>
  activationDeferredMountTabIds: ReadonlySet<string> | null
}

// Mirrors the memoized TerminalPaneOverlayLayer; a plain host would hide a stale useEffectEvent.
const MemoizedHost = memo(function MemoizedHost(props: HostProps) {
  useParkedTerminalWatcherSynchronization({ worktreeId: WORKTREE_ID, ...props })
  return null
})

function terminalTab(id: string): TerminalTab {
  return {
    id,
    ptyId: `${WORKTREE_ID}@@session-${id}`,
    worktreeId: WORKTREE_ID,
    title: id,
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: 0
  }
}

it('syncs a memoized host with the verdict of its latest render once a deferred tab is revealed', () => {
  const tabs = [terminalTab('tab-1'), terminalTab('tab-2')]
  const deferredAtStartup = new Set(['tab-1', 'tab-2'])
  const view = render(
    <MemoizedHost
      terminalTabs={tabs}
      parkedTabIds={deferredAtStartup}
      activationDeferredMountTabIds={deferredAtStartup}
    />
  )

  // Revealing tab-1 leaves only tab-2 deferred; a sync that still lists tab-1 keeps its watcher and hidden claim.
  const stillDeferred = new Set(['tab-2'])
  view.rerender(
    <MemoizedHost
      terminalTabs={tabs}
      parkedTabIds={stillDeferred}
      activationDeferredMountTabIds={stillDeferred}
    />
  )

  expect(vi.mocked(syncParkedTerminalTabWatchers).mock.calls.at(-1)?.[0]).toEqual({
    worktreeId: WORKTREE_ID,
    tabs,
    parkedTabIds: new Set(['tab-2']),
    restoreTitleOnStartTabIds: new Set(['tab-2'])
  })
})
