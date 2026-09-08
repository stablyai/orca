// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '../ui/tooltip'
import { SessionSearchStatusSegment } from './SessionSearchStatusSegment'
import type { AiVaultSearchIndexingProgress } from '../../../../shared/ai-vault-search-types'

const mocks = vi.hoisted(() => ({
  indexing: {
    coverage: null as unknown,
    busy: false,
    failed: false,
    observedAt: 0,
    phaseSince: 0
  },
  openSettingsPage: vi.fn(),
  setSettingsSearchQuery: vi.fn()
}))

vi.mock('../right-sidebar/ai-vault-search-coverage-poll', () => ({
  AI_VAULT_SEARCH_COVERAGE_POLL_MS: 4_000,
  useSearchIndexing: () => mocks.indexing
}))
vi.mock('@/store', () => ({
  useAppStore: Object.assign(() => ({ aiVaultSearch: { enabled: true } }), {
    getState: () => ({
      openSettingsPage: mocks.openSettingsPage,
      setSettingsSearchQuery: mocks.setSettingsSearchQuery
    })
  })
}))

afterEach(cleanup)
beforeEach(() => {
  vi.clearAllMocks()
})

function segment(
  progress: Partial<AiVaultSearchIndexingProgress> | null,
  observed: { observedAt: number; phaseSince: number } = { observedAt: 10_000, phaseSince: 0 }
) {
  mocks.indexing = {
    ...mocks.indexing,
    ...observed,
    coverage: progress
      ? {
          enabled: true,
          sessionsIndexed: 1,
          messagesIndexed: 1,
          providers: [],
          backfill: 'running',
          filesPending: 0,
          lastIndexedAt: null,
          indexing: {
            phase: 'indexing',
            filesProcessed: 3,
            filesTotal: 10,
            failures: 0,
            startedAt: 0,
            ...progress
          }
        }
      : null
  }
  render(
    <TooltipProvider>
      <SessionSearchStatusSegment iconOnly={false} />
    </TooltipProvider>
  )
}

it('reports the phase and how far the index has got', () => {
  segment({ phase: 'indexing', filesProcessed: 3, filesTotal: 10 })
  expect(screen.getByRole('button', { name: 'Indexing conversations · 30%' })).toBeTruthy()
})

it('stays out of the status bar once the index is up to date', () => {
  segment({ phase: 'complete' })
  expect(screen.queryByRole('button')).toBeNull()
})

it('waits out an incremental pass that may finish within one poll', () => {
  segment({ phase: 'updating' }, { observedAt: 1_000, phaseSince: 0 })
  expect(screen.queryByRole('button')).toBeNull()
})

it('shows an incremental pass that has outlived a poll interval', () => {
  segment({ phase: 'updating' }, { observedAt: 9_000, phaseSince: 0 })
  expect(screen.queryByRole('button')).not.toBeNull()
})

it('offers no controls of its own; the settings pane owns them', () => {
  segment({ phase: 'paused' })
  expect(screen.queryByRole('button', { name: 'Resume' })).toBeNull()
  expect(screen.getAllByRole('button')).toHaveLength(1)
})

it('opens the settings pane that owns the controls', () => {
  segment({ phase: 'paused' })
  fireEvent.click(screen.getByRole('button'))
  expect(mocks.openSettingsPage).toHaveBeenCalled()
  expect(mocks.setSettingsSearchQuery).toHaveBeenCalledWith('Agent Session History')
})

it('does not spin at an index that is waiting for someone to start it', () => {
  segment({ phase: 'idle' })
  const icon = screen.getByRole('button', { name: 'Waiting to index · 30%' }).querySelector('svg')
  // Why: nothing advances an idle index, so an animated spinner would promise progress
  // that will never arrive on its own.
  expect(icon?.getAttribute('class')).not.toContain('animate-spin')
})
