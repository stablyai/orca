import { describe, expect, it } from 'vitest'
import {
  resolveWindowsShiftEnterEncoding,
  resolveWindowsShiftEnterEncodingForPane
} from './terminal-windows-shift-enter'

describe('resolveWindowsShiftEnterEncoding', () => {
  it('uses CSI-u only for trusted Droid process evidence', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'droid', routingTrusted: true, shellForeground: false }
      })
    ).toBe('csi-u')
    expect(resolveWindowsShiftEnterEncoding({ launchAgentType: 'droid' })).toBe('alt-enter')
  })

  it('does not let hook or OSC-derived status forge Droid input routing', () => {
    const state = {
      paneForegroundAgentByPaneKey: {},
      agentStatusByPaneKey: {
        'tab:pane': { agentType: 'droid' as const }
      },
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane')).toBe('alt-enter')
  })

  it('keeps the legacy byte for Codex, Antigravity, unknown, and plain panes', () => {
    for (const agent of ['codex', 'antigravity', 'claude', null] as const) {
      expect(
        resolveWindowsShiftEnterEncoding({
          foreground: { agent, shellForeground: false }
        })
      ).toBe('alt-enter')
    }
    expect(resolveWindowsShiftEnterEncoding({})).toBe('alt-enter')
  })

  it('lets current process identity override stale launch ownership', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'antigravity', routingTrusted: true, shellForeground: false },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
  })

  it('fails closed while a newer command generation awaits trusted evidence', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'droid', shellForeground: false },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: null, shellForeground: false },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
  })

  it('keeps launch ownership on its original leaf after a split sibling survives', () => {
    const state = {
      paneForegroundAgentByPaneKey: {},
      agentLaunchConfigByPaneKey: {
        'tab:launched-droid': { identity: { agentType: 'droid' } }
      }
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:launched-droid')).toBe('alt-enter')
    // Why: after split→close leaves only the sibling, pane count is no longer
    // ownership evidence; the surviving leaf must keep the legacy fallback.
    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:surviving-sibling')).toBe(
      'alt-enter'
    )
  })

  it('clears stale Droid ownership after the foreground returns to the shell', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: null, shellForeground: true },
        launchAgentType: 'droid'
      })
    ).toBe('alt-enter')
  })
})
