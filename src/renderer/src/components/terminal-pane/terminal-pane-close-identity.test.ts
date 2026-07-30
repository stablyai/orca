import { describe, expect, it } from 'vitest'
import {
  resolveTabTitleAfterPaneClose,
  shouldClearLaunchAgentAfterSplitPaneClose,
  shouldClearLaunchAgentForClosedPane
} from './terminal-pane-close-identity'

describe('shouldClearLaunchAgentForClosedPane', () => {
  it('clears launch identity only when the launch-owning PTY closes', () => {
    const tab = { launchAgent: 'codex' as const, ptyId: 'pty-agent' }

    expect(shouldClearLaunchAgentForClosedPane(tab, 'pty-agent')).toBe(true)
    expect(shouldClearLaunchAgentForClosedPane(tab, 'pty-shell')).toBe(false)
  })

  it('does not mutate identity-free or not-yet-bound tabs', () => {
    expect(shouldClearLaunchAgentForClosedPane({ ptyId: 'pty-1' }, 'pty-1')).toBe(false)
    expect(
      shouldClearLaunchAgentForClosedPane({ launchAgent: 'claude', ptyId: null }, 'pty-1')
    ).toBe(false)
  })
})

describe('resolveTabTitleAfterPaneClose', () => {
  it('uses the promoted sibling title when one is known', () => {
    expect(resolveTabTitleAfterPaneClose({ 2: 'codex' }, 2)).toBe('codex')
  })

  it('resets to the tab fallback when the promoted shell has no title', () => {
    expect(resolveTabTitleAfterPaneClose({ 1: 'closed agent' }, 2)).toBe('')
    expect(resolveTabTitleAfterPaneClose({}, null)).toBe('')
  })

  it('does not reuse an agent-polluted tab title when the survivor has no runtime title', () => {
    expect(
      resolveTabTitleAfterPaneClose({}, 1, {
        title: '⠋ Codex',
        customTitle: null,
        quickCommandLabel: null,
        defaultTitle: 'Terminal 1'
      })
    ).toBe('Terminal 1')
    expect(
      resolveTabTitleAfterPaneClose({}, 1, {
        title: '⠋ Codex',
        customTitle: null,
        quickCommandLabel: null,
        defaultTitle: undefined
      })
    ).toBe('')
  })

  it('keeps a non-agent tab title when the runtime map is empty', () => {
    expect(
      resolveTabTitleAfterPaneClose({}, 1, {
        title: 'bash',
        customTitle: null,
        quickCommandLabel: null,
        defaultTitle: undefined
      })
    ).toBe('bash')
  })
})

describe('shouldClearLaunchAgentAfterSplitPaneClose', () => {
  const agentPaneKey = 'tab-1:11111111-1111-4111-8111-111111111111'
  const shellPaneKey = 'tab-1:22222222-2222-4222-8222-222222222222'

  it('clears launch identity when the closed split pane had the live agent', () => {
    expect(
      shouldClearLaunchAgentAfterSplitPaneClose({
        tab: { launchAgent: 'codex', ptyId: 'pty-shell' },
        closedPtyId: 'pty-agent',
        closedPaneKey: agentPaneKey,
        survivingPaneKeys: [shellPaneKey],
        agentStatusByPaneKey: {
          [agentPaneKey]: {
            paneKey: agentPaneKey,
            state: 'working',
            agentType: 'codex',
            prompt: 'Codex',
            updatedAt: 0,
            stateStartedAt: 0,
            stateHistory: []
          }
        }
      })
    ).toBe(true)
  })

  it('keeps launch identity when a surviving split pane still has a live agent', () => {
    expect(
      shouldClearLaunchAgentAfterSplitPaneClose({
        tab: { launchAgent: 'codex', ptyId: 'pty-shell' },
        closedPtyId: 'pty-agent',
        closedPaneKey: agentPaneKey,
        survivingPaneKeys: [shellPaneKey],
        agentStatusByPaneKey: {
          [shellPaneKey]: {
            paneKey: shellPaneKey,
            state: 'working',
            agentType: 'codex',
            prompt: 'Codex',
            updatedAt: 0,
            stateStartedAt: 0,
            stateHistory: []
          }
        }
      })
    ).toBe(false)
  })

  it('clears launch identity when a title-derived agent pane closes without hook status', () => {
    expect(
      shouldClearLaunchAgentAfterSplitPaneClose({
        tab: { launchAgent: 'codex', ptyId: 'pty-shell' },
        closedPtyId: 'pty-agent',
        closedPaneId: 1,
        closedPaneKey: agentPaneKey,
        runtimePaneTitlesByPaneId: { 1: '⠋ Codex' },
        survivingPaneKeys: [shellPaneKey],
        agentStatusByPaneKey: {}
      })
    ).toBe(true)
  })

  it('clears launch identity when a different agent survives in the split', () => {
    const piPaneKey = 'tab-1:33333333-3333-4333-8333-333333333333'
    expect(
      shouldClearLaunchAgentAfterSplitPaneClose({
        tab: { launchAgent: 'codex', ptyId: 'pty-shell' },
        closedPtyId: 'pty-agent',
        closedPaneId: 1,
        closedPaneKey: agentPaneKey,
        runtimePaneTitlesByPaneId: { 1: '⠋ Codex' },
        survivingPaneKeys: [piPaneKey],
        agentStatusByPaneKey: {
          [piPaneKey]: {
            paneKey: piPaneKey,
            state: 'working',
            agentType: 'pi',
            prompt: 'Pi',
            updatedAt: 0,
            stateStartedAt: 0,
            stateHistory: []
          }
        }
      })
    ).toBe(true)
  })
})
