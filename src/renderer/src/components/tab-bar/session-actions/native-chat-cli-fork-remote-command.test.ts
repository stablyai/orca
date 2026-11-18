// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { AppState } from '@/store/types'
import { createGlobalSettingsFixture } from '../../../../../shared/settings/global-settings-test-fixture'
import { withoutDesktopAgentCommands } from './native-chat-cli-fork-run'

// The fork's startup line is composed on this desktop and only executed on the paired host, so a
// desktop agent command override must not ride along (#44168).
describe('withoutDesktopAgentCommands', () => {
  it('empties the desktop command overrides and keeps every other setting', () => {
    const settings = createGlobalSettingsFixture({ agentCmdOverrides: { claude: 'FOO=BAR claude' } })
    const state = { settings } as unknown as AppState
    const stripped = withoutDesktopAgentCommands(state)
    expect(stripped.settings?.agentCmdOverrides).toEqual({})
    expect(stripped.settings?.defaultTuiAgent).toBe(settings.defaultTuiAgent)
    // The original state stays untouched.
    expect(state.settings?.agentCmdOverrides).toEqual({ claude: 'FOO=BAR claude' })
  })

  it('returns a settings-less state unchanged', () => {
    const state = { settings: null } as unknown as AppState
    expect(withoutDesktopAgentCommands(state)).toBe(state)
  })
})
