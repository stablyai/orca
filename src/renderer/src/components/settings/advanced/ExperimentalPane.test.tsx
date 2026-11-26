// @vitest-environment happy-dom

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { GlobalSettings } from '../../../../../shared/settings/global-settings-types'
import { useAppStore } from '../../../store/index'
import { ExperimentalPane } from './ExperimentalPane'
import { getExperimentalPaneSearchEntries, getExperimentalSearchEntry } from './experimental-search'

const DASHBOARD_TOGGLE = 'Toggle Agent Dashboard'
const ATTENTION_TOGGLE = 'Terminal attention'

function settingsWith(overrides: Partial<GlobalSettings> = {}): GlobalSettings {
  return { ...getDefaultSettings('/home/test'), ...overrides }
}

function hasSwitch(name: string): boolean {
  return screen.queryByRole('switch', { name }) !== null
}

beforeEach(() => {
  useAppStore.setState({ settingsSearchQuery: '' })
})

afterEach(cleanup)

describe('opt-in-only experiments in the Experimental pane', () => {
  it('hides Agent Dashboard and Terminal attention from a new user', () => {
    render(<ExperimentalPane settings={settingsWith()} updateSettings={() => {}} />)
    expect(hasSwitch(DASHBOARD_TOGGLE)).toBe(false)
    expect(hasSwitch(ATTENTION_TOGGLE)).toBe(false)
    // Other experiments are unaffected.
    expect(hasSwitch('Pet')).toBe(true)
  })

  it('keeps each row for a user who already turned it on', () => {
    render(
      <ExperimentalPane
        settings={settingsWith({
          experimentalAgentDashboardPopout: true,
          experimentalTerminalAttention: true
        })}
        updateSettings={() => {}}
      />
    )
    expect(hasSwitch(DASHBOARD_TOGGLE)).toBe(true)
    expect(hasSwitch(ATTENTION_TOGGLE)).toBe(true)
  })

  it('keeps a row on screen after the user switches it off, until the pane reopens', () => {
    const on = settingsWith({ experimentalTerminalAttention: true })
    const { rerender, unmount } = render(
      <ExperimentalPane settings={on} updateSettings={() => {}} />
    )
    const off = settingsWith({ experimentalTerminalAttention: false })
    rerender(<ExperimentalPane settings={off} updateSettings={() => {}} />)
    expect(
      screen.getByRole('switch', { name: ATTENTION_TOGGLE }).getAttribute('aria-checked')
    ).toBe('false')
    unmount()

    render(<ExperimentalPane settings={off} updateSettings={() => {}} />)
    expect(hasSwitch(ATTENTION_TOGGLE)).toBe(false)
  })

  it('shows both rows when hidden experiments are unlocked', () => {
    render(
      <ExperimentalPane
        settings={settingsWith()}
        updateSettings={() => {}}
        hiddenExperimentalUnlocked
      />
    )
    expect(hasSwitch(DASHBOARD_TOGGLE)).toBe(true)
    expect(hasSwitch(ATTENTION_TOGGLE)).toBe(true)
  })
})

describe('opt-in-only experiments in Settings search', () => {
  const dashboard = () => getExperimentalSearchEntry().agentDashboard
  const attention = () => getExperimentalSearchEntry().terminalAttention

  it('does not index them for a new user', () => {
    const entries = getExperimentalPaneSearchEntries({
      agentDashboard: false,
      terminalAttention: false
    })
    expect(entries).not.toContain(dashboard())
    expect(entries).not.toContain(attention())
    expect(entries).toContain(getExperimentalSearchEntry().pet)
  })

  it('indexes each one only while it is on', () => {
    const entries = getExperimentalPaneSearchEntries({
      agentDashboard: true,
      terminalAttention: false
    })
    expect(entries).toContain(dashboard())
    expect(entries).not.toContain(attention())
  })
})
