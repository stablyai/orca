// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import { AgentSessionHistoryPane, formatAiVaultSearchIndexSize } from './AgentSessionHistoryPane'

const searchIndexSize = vi.fn()
const clearSearchIndex = vi.fn()
const searchCoverage = vi.fn()

beforeEach(() => {
  searchIndexSize.mockReset().mockResolvedValue({ bytes: 3 * 1024 * 1024 })
  clearSearchIndex.mockReset().mockResolvedValue(null)
  searchCoverage.mockReset().mockRejectedValue(new Error('index status unavailable'))
  Object.defineProperty(window, 'api', {
    configurable: true,
    value: { aiVault: { searchIndexSize, clearSearchIndex, searchCoverage } }
  })
})

afterEach(cleanup)

function renderPane(
  aiVaultSearch: GlobalSettings['aiVaultSearch'],
  updateSettings = vi.fn().mockResolvedValue(undefined)
): { updateSettings: ReturnType<typeof vi.fn> } {
  render(
    <AgentSessionHistoryPane
      settings={{ aiVaultSearch } as GlobalSettings}
      updateSettings={updateSettings}
    />
  )
  return { updateSettings }
}

describe('formatAiVaultSearchIndexSize', () => {
  it('shows an em dash when there is no index file', () => {
    expect(formatAiVaultSearchIndexSize(null)).toBe('—')
  })

  it('scales bytes to the largest unit that keeps the number readable', () => {
    expect(formatAiVaultSearchIndexSize(512)).toBe('512 B')
    expect(formatAiVaultSearchIndexSize(3 * 1024 * 1024)).toBe('3.0 MB')
    expect(formatAiVaultSearchIndexSize(64 * 1024 * 1024)).toBe('64 MB')
  })
})

describe('AgentSessionHistoryPane', () => {
  it('reflects the off default and turns the index on', () => {
    const { updateSettings } = renderPane(undefined)

    const toggle = screen.getByRole('switch', { name: 'Search inside conversations' })
    expect(toggle.getAttribute('data-state')).toBe('unchecked')

    fireEvent.click(toggle)
    expect(updateSettings).toHaveBeenCalledWith({
      aiVaultSearch: { enabled: true, historyDays: null }
    })
  })

  it('writes the chosen history bound without dropping the enabled flag', () => {
    const { updateSettings } = renderPane({ enabled: true, historyDays: null })

    fireEvent.click(screen.getByRole('radio', { name: 'Last 30 days' }))

    expect(updateSettings).toHaveBeenCalledWith({
      aiVaultSearch: { enabled: true, historyDays: 30 }
    })
  })

  it('shows the index size on disk', async () => {
    renderPane({ enabled: true, historyDays: null })
    await waitFor(() => expect(screen.getByText('3.0 MB')).toBeTruthy())
  })

  it('deletes the index only after the confirmation is accepted', async () => {
    renderPane({ enabled: true, historyDays: null })
    await waitFor(() => expect(screen.getByText('3.0 MB')).toBeTruthy())

    fireEvent.click(screen.getByRole('button', { name: 'Clear index' }))
    expect(clearSearchIndex).not.toHaveBeenCalled()

    const confirm = screen
      .getAllByRole('button', { name: 'Clear index' })
      .find((button) => button.closest('[role="dialog"]'))
    fireEvent.click(confirm!)

    await waitFor(() => expect(clearSearchIndex).toHaveBeenCalledTimes(1))
  })

  it('blames the save only when the save itself was refused', async () => {
    const updateSettings = vi.fn().mockRejectedValue(new Error('settings write failed'))
    renderPane(undefined, updateSettings)

    fireEvent.click(screen.getByRole('switch', { name: 'Search inside conversations' }))
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Could not save search settings')
    )
  })

  it('keeps quiet about the save when only the follow-up status read failed', async () => {
    // Why: the write landed. A coverage read that did not is no evidence about the write, and
    // telling the user to try again would undo a setting they already changed.
    const updateSettings = vi.fn().mockResolvedValue(undefined)
    renderPane(undefined, updateSettings)

    fireEvent.click(screen.getByRole('switch', { name: 'Search inside conversations' }))
    await waitFor(() => expect(searchCoverage).toHaveBeenCalled())
    await waitFor(() => expect(updateSettings).toHaveBeenCalledTimes(1))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
