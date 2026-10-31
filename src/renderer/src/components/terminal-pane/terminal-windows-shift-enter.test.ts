import { describe, expect, it } from 'vitest'
import {
  resolveWindowsShiftEnterEncoding,
  resolveWindowsShiftEnterEncodingForPane
} from './terminal-windows-shift-enter'

describe('resolveWindowsShiftEnterEncoding', () => {
  it('does not select a keyboard mode from a task mentioning another agent', () => {
    const state = { paneForegroundAgentByPaneKey: {}, agentLaunchConfigByPaneKey: {} }
    expect(
      resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', '⠋ fix the droid launcher')
    ).toBe('alt-enter')
    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', '⠋ Droid')).toBe('csi-u')
  })

  it.each([
    ['. | Droid', 'alt-enter'],
    ['tmux | Droid', 'csi-u']
  ] as const)('uses the actual marker boundary for Windows input in %j', (title, encoding) => {
    expect(
      resolveWindowsShiftEnterEncodingForPane(
        { paneForegroundAgentByPaneKey: {}, agentLaunchConfigByPaneKey: {} },
        'tab:pane',
        title
      )
    ).toBe(encoding)
  })

  it('does not expose a keyboard mode inside a wrapped task barrier', () => {
    expect(
      resolveWindowsShiftEnterEncodingForPane(
        { paneForegroundAgentByPaneKey: {}, agentLaunchConfigByPaneKey: {} },
        'tab:pane',
        'tmux | ⠋ fix | a | b | c | d | e | f | g | Droid'
      )
    ).toBe('alt-enter')
  })

  it.each(['dsb', 'codex'] as const)(
    'keeps pending %s input encoding when a stale title names another agent',
    (agent) => {
      const state = {
        paneForegroundAgentByPaneKey: {
          'tab:pane': { agent, routingConfirmationPending: true, shellForeground: false }
        },
        agentLaunchConfigByPaneKey: {}
      }
      for (const title of ['Pi ready', 'OMP ready', 'Droid']) {
        expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', title)).toBe('alt-enter')
      }
    }
  )

  it.each(['pi', 'omp', 'droid'] as const)(
    'keeps pending %s CSI-u capability through a conflicting title',
    (agent) => {
      expect(
        resolveWindowsShiftEnterEncodingForPane(
          {
            paneForegroundAgentByPaneKey: {
              'tab:pane': { agent, routingConfirmationPending: true, shellForeground: false }
            },
            agentLaunchConfigByPaneKey: {}
          },
          'tab:pane',
          'DeepSeek Build'
        )
      ).toBe('csi-u')
    }
  )

  it('recovers a title capability when pending confirmation has no foreground identity', () => {
    expect(
      resolveWindowsShiftEnterEncodingForPane(
        {
          paneForegroundAgentByPaneKey: {
            'tab:pane': { agent: null, routingConfirmationPending: true, shellForeground: false }
          },
          agentLaunchConfigByPaneKey: {}
        },
        'tab:pane',
        'Pi ready'
      )
    ).toBe('csi-u')
  })

  it.each([
    { agent: 'dsb' as const, routingTrusted: true, shellForeground: false },
    { agent: 'dsb' as const, routingConfirmationPending: true, shellForeground: false }
  ])('keeps the generic encoding for recognition-only foreground evidence %j', (foreground) => {
    expect(resolveWindowsShiftEnterEncoding({ foreground })).toBe('alt-enter')
    expect(
      resolveWindowsShiftEnterEncodingForPane(
        {
          paneForegroundAgentByPaneKey: { 'tab:pane': foreground },
          agentLaunchConfigByPaneKey: {}
        },
        'tab:pane',
        'DeepSeek Build'
      )
    ).toBe('alt-enter')
  })

  it.each(['DeepSeek Build', '⠋ - Review Codex - DeepSeek Build'])(
    'keeps title-derived recognition-only identity %j on the generic encoding',
    (title) => {
      expect(
        resolveWindowsShiftEnterEncodingForPane(
          { paneForegroundAgentByPaneKey: {}, agentLaunchConfigByPaneKey: {} },
          'tab:pane',
          title
        )
      ).toBe('alt-enter')
      for (const foreground of [
        { agent: 'dsb' as const, routingRevoked: true, shellForeground: false },
        { agent: 'dsb' as const, shellForeground: true },
        { agent: 'dsb' as const, routingTrusted: true, shellForeground: false }
      ]) {
        expect(
          resolveWindowsShiftEnterEncodingForPane(
            {
              paneForegroundAgentByPaneKey: { 'tab:pane': foreground },
              agentLaunchConfigByPaneKey: {}
            },
            'tab:pane',
            'Pi ready'
          )
        ).toBe('alt-enter')
      }
    }
  )

  it('uses CSI-u only for trusted Droid process evidence', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'droid', routingTrusted: true, shellForeground: false }
      })
    ).toBe('csi-u')
    expect(resolveWindowsShiftEnterEncoding({ launchAgentType: 'droid' })).toBe('alt-enter')
  })

  it('uses CSI-u only for trusted Pi process evidence', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: { agent: 'pi', routingTrusted: true, shellForeground: false }
      })
    ).toBe('csi-u')
    expect(resolveWindowsShiftEnterEncoding({ launchAgentType: 'pi' })).toBe('alt-enter')
  })

  it('recovers Pi CSI-u from its explicit title when process trust is unavailable', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        'tab:pane': { agent: null, shellForeground: false }
      },
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', '⠸ Pi')).toBe('csi-u')
    expect(
      resolveWindowsShiftEnterEncodingForPane(
        { paneForegroundAgentByPaneKey: {}, agentLaunchConfigByPaneKey: {} },
        'tab:pane',
        'Pi ready'
      )
    ).toBe('csi-u')
  })

  // OMP wraps Pi despite owner-pinned titles; preserve Pi newline encoding or Esc+CR submits instead (#16373, #9703).
  it('recovers CSI-u from an OMP title, which wraps the same Pi reader', () => {
    const state = { paneForegroundAgentByPaneKey: {}, agentLaunchConfigByPaneKey: {} }
    // Owner normalization rebrands π session titles to OMP in the stored pane title.
    for (const title of [
      '⠸ OMP',
      'OMP ready',
      'OMP',
      'OMP - action required',
      'OMP - fixing the sidebar - orca',
      '⠋ OMP - fixing the sidebar - orca',
      'OMP > fixing the sidebar'
    ]) {
      expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', title)).toBe('csi-u')
    }
  })

  it('keeps trusted process and shell evidence authoritative over titles', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        'tab:pane': {
          agent: 'codex' as const,
          routingTrusted: true,
          shellForeground: false
        }
      },
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', 'Pi ready')).toBe('alt-enter')
    expect(
      resolveWindowsShiftEnterEncodingForPane(
        {
          paneForegroundAgentByPaneKey: {
            'tab:pane': { agent: null, shellForeground: true }
          },
          agentLaunchConfigByPaneKey: {}
        },
        'tab:pane',
        'Pi ready'
      )
    ).toBe('alt-enter')
  })

  it('does not let a stale title undo explicit routing revocation', () => {
    const state = {
      paneForegroundAgentByPaneKey: {
        'tab:pane': {
          agent: 'pi' as const,
          routingRevoked: true,
          shellForeground: false
        }
      },
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', 'Pi ready')).toBe('alt-enter')
  })

  it('keeps the last CSI-u capability while revocation confirmation is pending', () => {
    expect(
      resolveWindowsShiftEnterEncoding({
        foreground: {
          agent: 'pi',
          routingRevoked: true,
          routingConfirmationPending: true,
          shellForeground: false
        }
      })
    ).toBe('csi-u')
  })

  it('keeps legacy bytes for plain shell and unsupported-agent titles', () => {
    const state = {
      paneForegroundAgentByPaneKey: {},
      agentLaunchConfigByPaneKey: {}
    }

    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', 'C:\\work\\pi-project')).toBe(
      'alt-enter'
    )
    expect(resolveWindowsShiftEnterEncodingForPane(state, 'tab:pane', 'Codex')).toBe('alt-enter')
  })

  it('does not let hook status route bytes without a pane title or process proof', () => {
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
    // A surviving sibling cannot inherit launch ownership merely because split count returned to one.
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
