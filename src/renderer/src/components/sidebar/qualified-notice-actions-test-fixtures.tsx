import type {
  DetectedWorktreeListResult,
  DetectedWorktree
} from '../../../../shared/worktree/types'

import type {
  HostQualifiedDetectedWorktreeResult,
  ProviderRequestId
} from '../../../../shared/detected-worktree-provider-contract'
import type {
  WorktreeFetchOptions,
  DirectSshWorktreeFetchOptions
} from '@/store/slices/worktree-helpers'

import type { WorktreeCardProps } from './worktree-card-model'
import type WorktreeCardComponent from './WorktreeCard'

import type * as ReactVirtualModule from '@tanstack/react-virtual'
import type * as DesktopWindowChromeModule from '@/lib/desktop-window-chrome'
import { useMemo, useRef } from 'react'
import { cleanup } from '@testing-library/react'

import WorktreeList from './WorktreeList'
import { ConfirmationDialogProvider } from '../confirmation-dialog'
import WorktreeVisibilityDialog from './WorktreeVisibilityDialog'
import NewWorkspaceComposerModal from '../NewWorkspaceComposerModal'
import Settings from '../settings/Settings'
import type { VirtualizedScrollAnchor } from '@/hooks/useVirtualizedScrollAnchor'
import { afterEach, vi } from 'vitest'

import { z } from 'zod'

import { TooltipProvider } from '../ui/tooltip'
import { useAppStore } from '@/store'

import { repo, worktree } from './worktree-list-groups-test-fixtures'
export function fetchWorktreesFixture() {
  const providerRequestId = z
    .custom<ProviderRequestId>((value) => value === 'qualified-notice-fixture')
    .parse('qualified-notice-fixture')
  const ordinary = vi.fn(async (_repoId: string, _options?: WorktreeFetchOptions) => false)
  function fetchWorktrees(
    repoId: string,
    options: DirectSshWorktreeFetchOptions
  ): Promise<HostQualifiedDetectedWorktreeResult>
  function fetchWorktrees(repoId: string, options?: WorktreeFetchOptions): Promise<boolean>
  async function fetchWorktrees(
    repoId: string,
    options?: WorktreeFetchOptions | DirectSshWorktreeFetchOptions
  ): Promise<boolean | HostQualifiedDetectedWorktreeResult> {
    if (options && 'directSshAuthority' in options) {
      return {
        providerRequestId,
        executionHostId: options.executionHostId,
        status: 'rejected'
      }
    }
    return ordinary(repoId, options)
  }
  return { fetchWorktrees, ordinary }
}

const groupCards = vi.hoisted(() => ({ shipping: false }))

export const local = { ...repo, externalWorktreeVisibility: 'hide' as const }
export const remote = { ...local, path: '/server/repo', executionHostId: 'runtime:server' as const }
export function detected(path: string, extra: Partial<DetectedWorktree> = {}): DetectedWorktree {
  return {
    ...worktree,
    repoId: local.id,
    id: path,
    path,
    ownership: 'external',
    selectedCheckout: false,
    visible: false,
    ...extra
  }
}
export function envelope(
  rows: DetectedWorktree[],
  authoritative = true
): DetectedWorktreeListResult {
  return { repoId: repo.id, worktrees: rows, authoritative, source: 'git' }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true
afterEach(() => {
  cleanup()
  groupCards.shipping = false
  useAppStore.setState(useAppStore.getInitialState(), true)
})

vi.mock('@/lib/desktop-window-chrome', async (original) => ({
  ...(await original<typeof DesktopWindowChromeModule>()),
  isPairedWebClientWindow: () => true
}))
vi.mock('@tanstack/react-virtual', async (original) => ({
  ...(await original<typeof ReactVirtualModule>()),
  useVirtualizer: ({
    count,
    getItemKey
  }: ReactVirtualModule.VirtualizerOptions<HTMLDivElement, Element>) =>
    useMemo(
      () => ({
        elementsCache: new Map(),
        itemSizeCache: new Map(),
        scrollOffset: 0,
        getTotalSize: () => count * 56,
        getVirtualItems: () =>
          Array.from({ length: count }, (_, index) => ({
            index,
            key: getItemKey?.(index) ?? index,
            start: index * 56,
            size: 56,
            end: (index + 1) * 56,
            lane: 0
          })),
        measureElement: () => {},
        scrollToIndex: () => {},
        scrollToOffset: () => {}
      }),
      [count, getItemKey]
    )
}))
vi.mock('@/components/sidebar/WorktreeCard', async (original) => {
  const actual = await original<{ default: typeof WorktreeCardComponent }>()
  return {
    default: (props: WorktreeCardProps) =>
      groupCards.shipping ? <actual.default {...props} /> : <div />
  }
})

export function ShippingSidebar({
  includeSettings = false,
  board = false
}: {
  includeSettings?: boolean
  board?: boolean
}) {
  const activeView = useAppStore((state) => state.activeView)
  const offset = useRef(0)
  const anchor = useRef<VirtualizedScrollAnchor>(null)
  return (
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <WorktreeList
          scrollOffsetRef={offset}
          scrollAnchorRef={anchor}
          workspaceBoardOpen={board}
        />
        <WorktreeVisibilityDialog />
        <NewWorkspaceComposerModal />
        {includeSettings && activeView === 'settings' ? <Settings /> : null}
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
}

export { groupCards }
