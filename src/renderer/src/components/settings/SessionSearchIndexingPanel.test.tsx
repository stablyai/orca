// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { SessionSearchIndexingPanel } from './SessionSearchIndexingPanel'
import type { AiVaultSearchCoverage } from '../../../../shared/ai-vault-search-types'

afterEach(cleanup)
const base: AiVaultSearchCoverage = {
  enabled: true,
  sessionsIndexed: 12,
  messagesIndexed: 30,
  providers: [],
  backfill: 'running',
  filesPending: 0,
  lastIndexedAt: null
}
function panel(indexing?: AiVaultSearchCoverage['indexing']) {
  const onControl = vi.fn()
  render(
    <SessionSearchIndexingPanel
      coverage={{ ...base, indexing }}
      busy={false}
      failed={false}
      onControl={onControl}
    />
  )
  return onControl
}

it('does not invent a percentage during discovery', () => {
  const onControl = panel({
    phase: 'discovering',
    filesProcessed: 0,
    filesTotal: null,
    failures: 0,
    startedAt: 0
  })
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  expect(screen.queryByText(/Files processed/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Pause' }))
  expect(onControl).toHaveBeenCalledWith(true)
})

it('keeps the processed count and searchable count visible while paused', () => {
  const onControl = panel({
    phase: 'paused',
    filesProcessed: 25,
    filesTotal: 100,
    failures: 0,
    startedAt: 0
  })
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('25')
  expect(screen.getByText('Searchable conversations: 12 · Messages: 30')).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Resume' }))
  expect(onControl).toHaveBeenCalledWith(false)
})

it('offers retry after partial failure without calling it complete', () => {
  const onControl = panel({
    phase: 'error',
    filesProcessed: 100,
    filesTotal: 100,
    failures: 2,
    startedAt: 0
  })
  expect(screen.queryByText('Up to date')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  expect(onControl).toHaveBeenCalledWith(false)
})

it('does not offer unsupported controls for legacy coverage', () => {
  panel()
  expect(screen.queryByRole('button')).toBeNull()
  expect(screen.getByText('Searchable conversations: 12 · Messages: 30')).toBeTruthy()
})

it('falls back to an indeterminate bar rather than printing 12,000 of 10,000 as 100%', () => {
  panel({
    phase: 'updating',
    filesProcessed: 12_000,
    filesTotal: 10_000,
    failures: 0,
    startedAt: 0
  })
  expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBeNull()
  expect(screen.queryByText(/Files processed/)).toBeNull()
})
