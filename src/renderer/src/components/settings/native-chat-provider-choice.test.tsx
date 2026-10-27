// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { AgentDefaultSetting } from './AgentDefaultSetting'
import { buildDefaultAgentOpensAs } from './native-chat-provider-choice'

const store = vi.hoisted((): { settings: unknown } => ({ settings: null }))
vi.mock('../../store', () => ({ useAppStore: { getState: () => store } }))
afterEach(cleanup)

function renderDefault(settings: ReturnType<typeof createGlobalSettingsFixture>) {
  const updateSettings = vi.fn()
  store.settings = settings
  render(
    <AgentDefaultSetting
      defaultAgent={settings.defaultTuiAgent}
      detectedIds={new Set(['claude'])}
      enabledDetectedAgents={[]}
      catalog={[]}
      description=""
      opensAs={buildDefaultAgentOpensAs({
        defaultAgent: settings.defaultTuiAgent,
        settings,
        updateSettings,
        installedHere: ['claude']
      })}
      onSetDefault={vi.fn()}
    />
  )
  return updateSettings
}

describe('default agent chat or CLI', () => {
  it("flips the default agent's own chat switch, the one Providers and the + menu read", async () => {
    const updateSettings = renderDefault(
      createGlobalSettingsFixture({
        experimentalNativeChat: true,
        defaultTuiAgent: 'claude',
        nativeChatProviders: { codex: false }
      })
    )
    const group = screen.getByRole('radiogroup', { name: 'Open Claude as' })
    expect(group.querySelector('[aria-checked="true"]')?.textContent).toBe('Chat')
    fireEvent.click(screen.getByRole('radio', { name: 'CLI' }))
    await vi.waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        nativeChatProviders: { codex: false, claude: false }
      })
    )
  })

  it('offers no choice while Chat UI is off', () => {
    renderDefault(
      createGlobalSettingsFixture({ experimentalNativeChat: false, defaultTuiAgent: 'claude' })
    )
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})
