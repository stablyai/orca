// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import { matchesSettingsSearch } from '../search/settings-search'
import { TabSizingSettings } from './TabSizingSettings'
import { getTabSizingSearchEntries } from './tab-sizing-search'

beforeEach(() => useAppStore.setState({ settingsSearchQuery: '' }))
afterEach(() => cleanup())

function visibleRowCount(query: string): number {
  useAppStore.setState({ settingsSearchQuery: query })
  render(<TabSizingSettings settings={{}} updateSettings={vi.fn()} />)
  const count = ['Tab Sizing', 'Tab Min Width', 'Tab Max Width'].filter(
    (label) => screen.queryAllByText(label, { exact: true }).length > 0
  ).length
  cleanup()
  return count
}

it.each(['size', 'fixed-width', 'narrow', 'sizing', 'tab max', 'scrolls', 'unrelated'])(
  'the General catalog and the rendered rows agree on %s',
  (query) => {
    const catalogMatches = matchesSettingsSearch(query, getTabSizingSearchEntries())
    expect(visibleRowCount(query) > 0).toBe(catalogMatches)
  }
)

it('finds tab sizing by size and fixed-width', () => {
  expect(visibleRowCount('size')).toBe(3)
  expect(visibleRowCount('fixed-width')).toBe(1)
})
