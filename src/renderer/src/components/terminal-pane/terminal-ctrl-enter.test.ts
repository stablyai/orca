import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CustomTuiAgent } from '../../../../shared/types'
import type { AppState } from '../../store/types'
import { useAppStore } from '../../store'
import { hasCtrlEnterCsiUAuthorityForPane } from './terminal-ctrl-enter'

const PANE_KEY = 'tab:pane'

describe('hasCtrlEnterCsiUAuthorityForPane', () => {
  it('authorizes only trusted Ctrl+Enter CSI-u consumers', () => {
    for (const agent of ['droid', 'grok'] as const) {
      expect(
        hasCtrlEnterCsiUAuthorityForPane(
          {
            paneForegroundAgentByPaneKey: {
              [PANE_KEY]: { agent, routingTrusted: true, shellForeground: false }
            }
          },
          PANE_KEY
        )
      ).toBe(true)
    }
    expect(
      hasCtrlEnterCsiUAuthorityForPane(
        {
          paneForegroundAgentByPaneKey: {
            [PANE_KEY]: { agent: 'pi', routingTrusted: true, shellForeground: false }
          }
        },
        PANE_KEY
      )
    ).toBe(false)
  })

  it('uses strict titles only through unrevoked trust gaps', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: 'droid' as const, shellForeground: false }
      }
    }
    expect(hasCtrlEnterCsiUAuthorityForPane(state, PANE_KEY, '⠋ Droid')).toBe(true)
    expect(hasCtrlEnterCsiUAuthorityForPane(state, PANE_KEY, 'C:\\work\\grok-project')).toBe(false)
    expect(
      hasCtrlEnterCsiUAuthorityForPane(
        {
          paneForegroundAgentByPaneKey: {
            [PANE_KEY]: { agent: 'pi', shellForeground: false }
          }
        },
        PANE_KEY,
        'Droid'
      )
    ).toBe(false)

    for (const foreground of [
      { agent: 'grok' as const, routingRevoked: true, shellForeground: false },
      { agent: null, shellForeground: true },
      { agent: 'droid' as const, routingTrusted: true, shellForeground: true }
    ]) {
      expect(
        hasCtrlEnterCsiUAuthorityForPane(
          { paneForegroundAgentByPaneKey: { [PANE_KEY]: foreground } },
          PANE_KEY,
          'Grok'
        )
      ).toBe(false)
    }
  })
})

describe('custom-agent foregrounds', () => {
  // Regression: TUI_AGENT_CONFIG is keyed by built-in ids only — indexing with a
  // custom foreground id read `ctrlEnterEncoding` off undefined and threw.
  const CUSTOM_DROID_ID = 'custom-agent:droid:0f9f1c22-2a1b-4c33-9a44-55d6e7f8a901' as const
  const CUSTOM_PI_ID = 'custom-agent:pi:0f9f1c22-2a1b-4c33-9a44-55d6e7f8a902' as const

  function derivedAgent(
    id: CustomTuiAgent['id'],
    baseAgent: CustomTuiAgent['baseAgent']
  ): CustomTuiAgent {
    return { id, baseAgent, label: `${baseAgent} (derived)`, args: '', env: {}, syncEnv: false }
  }

  let originalSettings: AppState['settings']

  beforeEach(() => {
    originalSettings = useAppStore.getState().settings
    useAppStore.setState({
      settings: {
        customTuiAgents: [derivedAgent(CUSTOM_DROID_ID, 'droid'), derivedAgent(CUSTOM_PI_ID, 'pi')],
        deletedCustomTuiAgents: []
      } as unknown as AppState['settings']
    })
  })

  afterEach(() => {
    useAppStore.setState({ settings: originalSettings })
  })

  function trustedState(
    agent: CustomTuiAgent['id']
  ): Parameters<typeof hasCtrlEnterCsiUAuthorityForPane>[0] {
    return {
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent, routingTrusted: true, shellForeground: false }
      }
    }
  }

  it('a trusted custom agent inherits its base CSI-u capability without throwing', () => {
    expect(() =>
      hasCtrlEnterCsiUAuthorityForPane(trustedState(CUSTOM_DROID_ID), PANE_KEY)
    ).not.toThrow()
    expect(hasCtrlEnterCsiUAuthorityForPane(trustedState(CUSTOM_DROID_ID), PANE_KEY)).toBe(true)
    expect(hasCtrlEnterCsiUAuthorityForPane(trustedState(CUSTOM_PI_ID), PANE_KEY)).toBe(false)
  })

  it('matches a custom foreground against its base committed title', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        [PANE_KEY]: { agent: CUSTOM_DROID_ID, shellForeground: false }
      }
    }
    expect(hasCtrlEnterCsiUAuthorityForPane(state, PANE_KEY, '⠋ Droid')).toBe(true)
    expect(hasCtrlEnterCsiUAuthorityForPane(state, PANE_KEY, 'C:\\work\\grok-project')).toBe(false)
  })

  it('denies CSI-u for a custom id the catalog cannot resolve', () => {
    useAppStore.setState({
      settings: {
        customTuiAgents: [],
        deletedCustomTuiAgents: []
      } as unknown as AppState['settings']
    })
    expect(() =>
      hasCtrlEnterCsiUAuthorityForPane(trustedState(CUSTOM_DROID_ID), PANE_KEY)
    ).not.toThrow()
    expect(hasCtrlEnterCsiUAuthorityForPane(trustedState(CUSTOM_DROID_ID), PANE_KEY)).toBe(false)
  })
})
