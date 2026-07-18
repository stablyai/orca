import { describe, expect, it } from 'vitest'
import {
  resolveAgentShiftEnterEncoding,
  resolveAgentShiftEnterEncodingForPane,
  resolveWindowsShiftEnterEncoding,
  resolveWindowsShiftEnterEncodingForPane
} from './terminal-windows-shift-enter'

describe('resolveAgentShiftEnterEncoding', () => {
  it('routes trusted Codex panes through Ctrl+J', () => {
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: 'codex', routingTrusted: true, shellForeground: false }
      })
    ).toBe('ctrl-j')
  })

  it('does not apply stale Codex routing to shells or newer null evidence', () => {
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: null, routingTrusted: true, shellForeground: true },
        launchAgentType: 'codex'
      })
    ).toBeNull()
  })

  it('keeps Orca-known Codex routing available when remote process confirmation is unavailable', () => {
    expect(
      resolveAgentShiftEnterEncoding({
        launchAgentType: 'codex',
        allowUntrustedCodexFallback: true
      })
    ).toBe('ctrl-j')
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: 'codex', shellForeground: false },
        launchAgentType: 'codex',
        allowUntrustedCodexFallback: true
      })
    ).toBe('ctrl-j')
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: 'codex', shellForeground: false },
        allowUntrustedCodexFallback: true
      })
    ).toBeNull()
  })

  it('keeps display-only Codex identity from routing bytes on local panes', () => {
    expect(resolveAgentShiftEnterEncoding({ launchAgentType: 'codex' })).toBeNull()
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: 'codex', shellForeground: false },
        launchAgentType: 'codex'
      })
    ).toBeNull()
  })

  it('does not reuse stale Codex launch identity after newer foreground evidence', () => {
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: null, shellForeground: false },
        launchAgentType: 'codex'
      })
    ).toBeNull()
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: 'antigravity', shellForeground: false },
        launchAgentType: 'codex'
      })
    ).toBeNull()
  })

  it('keeps routing scoped to the active leaf', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        'tab:codex': { agent: 'codex' as const, routingTrusted: true, shellForeground: false }
      },
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveAgentShiftEnterEncodingForPane(state, 'tab:codex')).toBe('ctrl-j')
    expect(resolveAgentShiftEnterEncodingForPane(state, 'tab:sibling')).toBeNull()
  })

  it('retires remote Codex fallback when pane launch ownership is cleared', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        'tab:codex': { agent: 'codex' as const, shellForeground: false }
      },
      agentLaunchConfigByPaneKey: {
        'tab:codex': { identity: { agentType: 'codex' as const } }
      } as Record<string, { identity: { agentType: 'codex' } } | undefined>
    }

    expect(resolveAgentShiftEnterEncodingForPane(state, 'tab:codex', true)).toBe('ctrl-j')
    delete state.agentLaunchConfigByPaneKey['tab:codex']
    expect(resolveAgentShiftEnterEncodingForPane(state, 'tab:codex', true)).toBeNull()
  })

  it('blocks remote Codex fallback after explicit exit-risk evidence', () => {
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: { agent: 'codex', routingTrusted: false, shellForeground: false },
        launchAgentType: 'codex',
        allowUntrustedCodexFallback: true
      })
    ).toBeNull()
  })

  it('restores remote Codex fallback for a newer launch generation', () => {
    expect(
      resolveAgentShiftEnterEncoding({
        foreground: {
          agent: 'codex',
          routingTrusted: false,
          blockedLaunchRegisteredAt: 10,
          shellForeground: false
        },
        launchAgentType: 'codex',
        launchRegisteredAt: 11,
        allowUntrustedCodexFallback: true
      })
    ).toBe('ctrl-j')
  })
})

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
