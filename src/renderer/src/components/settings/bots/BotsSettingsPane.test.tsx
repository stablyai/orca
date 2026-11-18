// @vitest-environment happy-dom

import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'

vi.mock('@/lib/bot-catalog', () => ({ useBots: () => [], useHostBots: () => [] }))
vi.mock('@/components/bots/slack/SlackWorkspacesSettings', () => ({
  slackWorkspaces: () => [],
  SlackWorkspacesSettings: () => <div>Slack workspaces</div>
}))
vi.mock('@/components/bots/composio/ComposioKeyControl', () => ({
  ComposioKeyControl: () => <div>Composio key control</div>
}))

import { BotsSettingsPane } from './BotsSettingsPane'

afterEach(cleanup)

function renderPane(botsEnabled?: boolean) {
  const updateSettings = vi.fn()
  const settings = { ...getDefaultSettings('/home/me'), botsEnabled }
  render(<BotsSettingsPane settings={settings} updateSettings={updateSettings} />)
  return updateSettings
}

describe('BotsSettingsPane', () => {
  it('has bots on when nothing was saved, and turns them off from its switch', () => {
    const updateSettings = renderPane(undefined)

    expect(screen.getByText('Slack workspaces')).toBeTruthy()
    expect(screen.getByText('Composio key control')).toBeTruthy()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable bots' }))
    expect(updateSettings).toHaveBeenCalledWith({ botsEnabled: false })
  })

  it('shows only the switch while bots are off, and turns them back on', () => {
    const updateSettings = renderPane(false)

    expect(screen.queryByText('Slack workspaces')).toBeNull()
    fireEvent.click(screen.getByRole('switch', { name: 'Enable bots' }))
    expect(updateSettings).toHaveBeenCalledWith({ botsEnabled: true })
  })
})
