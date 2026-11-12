// @vitest-environment happy-dom
// ARCHIVE-REACH: Home always reaches archived workspaces, however few are active.
import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { EmptyState } from './CloudWorkspacesStates'
import {
  CloudWorkspacesToolbar,
  INITIAL_CLOUD_WORKSPACE_FILTERS as DEFAULTS,
  shouldShowCloudHomeArchivedOnly,
  shouldShowCloudHomeFilters
} from './CloudWorkspacesToolbar'
import { resetCloudArchivedCountCache, useCloudArchivedCount } from './use-cloud-archived-count'

vi.mock('../new-workspace/run-on/OrcaCloudTrialUsedUpNotice', () => ({
  OrcaCloudTrialUsedUpBanner: () => null
}))
vi.mock('@/hooks/useOrcaCloudApiAvailability', () => ({ useOrcaCloudApiAvailable: () => false }))

afterEach(cleanup)

/** What Home decides for `active` active workspaces and `archived` archived ones, no filter on. */
function homeRow(active: number, archived: number) {
  const showFilters = shouldShowCloudHomeFilters(active, DEFAULTS, true)
  return { showFilters, archivedOnly: shouldShowCloudHomeArchivedOnly(showFilters, archived) }
}

describe('which filter row Home shows', () => {
  it.each([
    [0, 0, { showFilters: false, archivedOnly: false }],
    [0, 1, { showFilters: false, archivedOnly: true }],
    [3, 0, { showFilters: false, archivedOnly: false }],
    [3, 2, { showFilters: false, archivedOnly: true }],
    [5, 0, { showFilters: true, archivedOnly: false }],
    [5, 4, { showFilters: true, archivedOnly: false }]
  ])('%i active, %i archived', (active, archived, expected) => {
    expect(homeRow(active, archived)).toEqual(expected)
  })

  it('an unknown count (read failed or loading) keeps today’s row', () => {
    expect(shouldShowCloudHomeArchivedOnly(false, null)).toBe(false)
  })
})

function toolbar(props: {
  showFilters: boolean
  archivedOnly: boolean
  archivedCount: number | null
  archived?: boolean
}) {
  const onFiltersChange = vi.fn()
  render(
    <TooltipProvider>
      <CloudWorkspacesToolbar
        filters={{ ...DEFAULTS, archived: props.archived ?? false }}
        onFiltersChange={onFiltersChange}
        hasOrg
        owners={[]}
        repos={[]}
        directory={new Map()}
        selfId="u1"
        meta={null}
        metaStale={false}
        reading={false}
        onRefresh={vi.fn()}
        showFilters={props.showFilters}
        archivedOnly={props.archivedOnly}
        archivedCount={props.archivedCount}
      />
    </TooltipProvider>
  )
  return onFiltersChange
}

describe('the Archived switch', () => {
  it('below 5 active with archived ones: only the switch, with its count, and it turns on', () => {
    const onFiltersChange = toolbar({ showFilters: false, archivedOnly: true, archivedCount: 3 })
    expect(screen.getByText('Archived (3)')).toBeTruthy()
    // JA-30's minimal row otherwise: no owner/repo filters, no Running switch.
    const own = document.querySelector('[data-cloud-home-archived-only]')
    expect(own?.contains(screen.getByRole('switch', { name: 'Show archived' }))).toBe(true)
    // JA-30's filter row (owner/repo, Running) stays hidden.
    const running = screen.getByRole('switch', { name: 'Show running only' })
    expect(running.closest('.hidden')).not.toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }))
    expect(onFiltersChange).toHaveBeenCalledWith({ archived: true })
  })

  it('below 5 active with none archived: no switch at all (JA-30 unchanged)', () => {
    toolbar({ showFilters: false, archivedOnly: false, archivedCount: 0 })
    expect(screen.queryByRole('switch', { name: 'Show archived' })).toBeNull()
  })

  it('at 5+ active: the full row, and the switch shows the count too', () => {
    toolbar({ showFilters: true, archivedOnly: false, archivedCount: 4 })
    expect(screen.getByRole('switch', { name: 'Show running only' })).toBeTruthy()
    expect(screen.getAllByRole('switch', { name: 'Show archived' })).toHaveLength(1)
    expect(screen.getByText('Archived (4)')).toBeTruthy()
  })

  it('at 5+ active with none archived: plain "Archived"', () => {
    toolbar({ showFilters: true, archivedOnly: false, archivedCount: 0 })
    expect(screen.getByText('Archived')).toBeTruthy()
  })
})

describe('the empty state', () => {
  it('every workspace archived: says so, keeps New, and offers Show archived (N)', () => {
    const onShowArchived = vi.fn()
    render(
      <EmptyState
        scope="mine"
        archived={false}
        filtered={false}
        archivedCount={2}
        onShowArchived={onShowArchived}
      />
    )
    expect(screen.getByText('All your cloud workspaces are archived')).toBeTruthy()
    expect(screen.queryByText('You don’t have any cloud workspaces yet.')).toBeNull()
    expect(screen.getByRole('button', { name: 'New cloud workspace' })).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Show archived (2)' }))
    expect(onShowArchived).toHaveBeenCalledOnce()
  })

  it('nothing archived: the first-run invitation, no Show archived link', () => {
    render(
      <EmptyState
        scope="team"
        archived={false}
        filtered={false}
        archivedCount={0}
        onShowArchived={vi.fn()}
      />
    )
    expect(screen.getByText('Start your first cloud workspace')).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Show archived/ })).toBeNull()
  })
})

describe('useCloudArchivedCount', () => {
  const list = vi.fn()
  beforeEach(() => {
    resetCloudArchivedCountCache()
    list.mockReset()
    Object.defineProperty(window, 'api', {
      configurable: true,
      value: { cloudWorkspaces: { list } }
    })
  })

  it('reads archived=only once per active list, and again when the active list changes', async () => {
    list.mockResolvedValue({ ok: true, value: [{ id: 'a' }, { id: 'b' }] })
    const { result, rerender } = renderHook(
      (ids: string[]) =>
        useCloudArchivedCount({ account: 'u:o', scope: 'mine', activeIds: ids, enabled: true }),
      { initialProps: ['w1'] }
    )
    await waitFor(() => expect(result.current).toBe(2))
    expect(list).toHaveBeenCalledWith({ scope: 'mine', archived: 'only' })
    // Home polls: the same active list reuses the cached count.
    rerender(['w1'])
    renderHook(() =>
      useCloudArchivedCount({ account: 'u:o', scope: 'mine', activeIds: ['w1'], enabled: true })
    )
    expect(list).toHaveBeenCalledTimes(1)
    // Archiving the only workspace empties the active list: read again.
    list.mockResolvedValue({ ok: true, value: [{ id: 'a' }, { id: 'b' }, { id: 'w1' }] })
    rerender([])
    await waitFor(() => expect(result.current).toBe(3))
    expect(list).toHaveBeenCalledTimes(2)
  })

  it('stays null on a failed read or while the active list loads, so Home keeps today’s row', async () => {
    list.mockResolvedValue({ ok: false, error: 'unavailable' })
    const failed = renderHook(() =>
      useCloudArchivedCount({ account: 'u:o', scope: 'team', activeIds: [], enabled: true })
    )
    await waitFor(() => expect(list).toHaveBeenCalled())
    expect(failed.result.current).toBeNull()
    const loading = renderHook(() =>
      useCloudArchivedCount({ account: 'u:o', scope: 'team', activeIds: null, enabled: true })
    )
    expect(loading.result.current).toBeNull()
  })
})
