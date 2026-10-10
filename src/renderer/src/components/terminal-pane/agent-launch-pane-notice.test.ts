import { describe, expect, it, vi } from 'vitest'

const CATALOG: Record<string, string> = {
  'auto.components.terminal.pane.AgentLaunchPaneNotice.notStarted': '智能体无法启动。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.unconfirmed': '无法确认智能体已启动。',
  'auto.components.terminal.pane.AgentLaunchPaneNotice.exitedDuringStart': '它在启动时退出了。'
}
vi.mock('@/i18n/i18n', () => ({
  translate: (key: string, fallback: string) => CATALOG[key] ?? fallback
}))

const { agentLaunchPaneNoticeText, agentLaunchPaneOutcomeForLeaf } =
  await import('./agent-launch-pane-notice-text')

describe("the pane of a launch whose agent isn't running", () => {
  it("says it couldn't start, in the viewer's language, with a reason they can act on", () => {
    expect(
      agentLaunchPaneNoticeText({ kind: 'not-started', code: 'agent_session_exited_during_start' })
    ).toBe('智能体无法启动。 它在启动时退出了。')
  })

  it('never shows a host error code', () => {
    expect(
      agentLaunchPaneNoticeText({ kind: 'not-started', code: 'agent_launch_pane_already_live' })
    ).toBe('智能体无法启动。')
  })

  it("says it can't confirm, never that it failed, when nobody knows", () => {
    expect(agentLaunchPaneNoticeText({ kind: 'unconfirmed' })).toBe('无法确认智能体已启动。')
  })
})

describe('which pane shows it', () => {
  const tab = { agentLaunchPane: { leafId: 'leaf-1', outcome: { kind: 'unconfirmed' as const } } }

  it('the leaf the launch laid out, once its fate is final', () => {
    expect(agentLaunchPaneOutcomeForLeaf(tab, 'leaf-1')).toEqual({ kind: 'unconfirmed' })
    expect(agentLaunchPaneOutcomeForLeaf(tab, 'leaf-2')).toBeNull()
    expect(
      agentLaunchPaneOutcomeForLeaf({ agentLaunchPane: { leafId: 'leaf-1' } }, 'leaf-1')
    ).toBeNull()
    expect(agentLaunchPaneOutcomeForLeaf(undefined, 'leaf-1')).toBeNull()
  })
})
