import { describe, expect, it } from 'vitest'
import { hasCtrlEnterCsiUAuthorityForPane } from './terminal-ctrl-enter'

const PANE_KEY = 'tab:pane'

describe('hasCtrlEnterCsiUAuthorityForPane', () => {
  it.each([
    { agent: 'dsb' as const, routingTrusted: true, shellForeground: false },
    { agent: 'dsb' as const, routingConfirmationPending: true, shellForeground: false }
  ])('keeps recognition-only foreground evidence %j off CSI-u', (foreground) => {
    expect(
      hasCtrlEnterCsiUAuthorityForPane(
        { paneForegroundAgentByPaneKey: { [PANE_KEY]: foreground } },
        PANE_KEY,
        'DeepSeek Build'
      )
    ).toBe(false)
  })

  it.each(['DeepSeek Build', '⠋ - Review Codex - DeepSeek Build'])(
    'keeps title-derived recognition-only identity %j off CSI-u',
    (title) => {
      expect(
        hasCtrlEnterCsiUAuthorityForPane({ paneForegroundAgentByPaneKey: {} }, PANE_KEY, title)
      ).toBe(false)
      for (const foreground of [
        { agent: 'dsb' as const, routingRevoked: true, shellForeground: false },
        { agent: 'dsb' as const, shellForeground: true },
        { agent: 'dsb' as const, shellForeground: false },
        { agent: 'grok' as const, shellForeground: false }
      ]) {
        expect(
          hasCtrlEnterCsiUAuthorityForPane(
            { paneForegroundAgentByPaneKey: { [PANE_KEY]: foreground } },
            PANE_KEY,
            foreground.agent === 'grok' ? title : 'Grok'
          )
        ).toBe(false)
      }
    }
  )

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
