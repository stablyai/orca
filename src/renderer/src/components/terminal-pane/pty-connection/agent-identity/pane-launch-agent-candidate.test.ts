import { expect, it } from 'vitest'
import { paneShouldAnswerOscColorQueries } from './pane-launch-agent-candidate'

const pane = { worktreeId: 'wt', tabId: 'tab', paneKey: 'pane' }

function stateFor(launchAgent: string) {
  return {
    tabsByWorktree: { wt: [{ id: 'tab', launchAgent }] },
    agentLaunchConfigByPaneKey: {}
  }
}

it('does not answer OSC color queries for an Antigravity pane', () => {
  expect(paneShouldAnswerOscColorQueries(stateFor('antigravity'), pane)).toBe(false)
  expect(paneShouldAnswerOscColorQueries(stateFor('codex'), pane)).toBe(true)
})
