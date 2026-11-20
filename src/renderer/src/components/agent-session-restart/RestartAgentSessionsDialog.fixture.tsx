import { defineFixture } from '../../component-fixtures/component-fixture'
import { setRendererUiLanguage } from '@/i18n/i18n'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { acceptedAgentStatuses } from '@/store/slices/agent-status/status-ownership/accepted-agent-statuses'
import { makePaneKey } from '../../../../shared/workspace-layout/stable-pane-id'
import type { AgentRestartCandidate } from '@/lib/agent-session/manual-restart/local-agent-restart-candidates'
import type { AgentStatusEntry } from '../../../../shared/agent-status/contracts/agent-status-types'
import type { TerminalTab } from '../../../../shared/workspace-layout/terminal-tab-types'
import { RestartAgentSessionsPromptDialog } from './RestartAgentSessionsDialog'

const now = Date.now()
const ORCA = 'repo-1::/orca'
const SITE = 'repo-2::/landing-page'

const pane = (index: number, worktreeId: string) => ({
  ptyId: `pty-${index}`,
  tabId: `tab-${index}`,
  leafId: `00000000-0000-4000-8000-00000000000${index}`,
  worktreeId
})

const candidates: AgentRestartCandidate[] = [
  { ...pane(0, ORCA), agent: 'claude', restartable: true, quiet: true },
  { ...pane(1, ORCA), agent: 'claude', restartable: true, quiet: false },
  { ...pane(2, SITE), agent: 'codex', restartable: true, quiet: true },
  { ...pane(3, SITE), agent: 'codex', restartable: false, reason: 'no-session', quiet: false }
]

const prompts = [
  'Fix the flaky terminal resize test',
  'Refactor the account switch toasts',
  'Update the pricing table copy'
]

function tab(candidate: AgentRestartCandidate): TerminalTab {
  return {
    id: candidate.tabId,
    ptyId: candidate.ptyId,
    worktreeId: candidate.worktreeId,
    title: candidate.agent === 'claude' ? 'Claude' : 'Codex',
    customTitle: null,
    color: null,
    sortOrder: 0,
    createdAt: now
  }
}

function status(prompt: string, index: number): [string, AgentStatusEntry] {
  const candidate = candidates[index]
  const paneKey = makePaneKey(candidate.tabId, candidate.leafId)
  return [
    paneKey,
    {
      paneKey,
      worktreeId: candidate.worktreeId,
      tabId: candidate.tabId,
      agentType: candidate.agent,
      state: candidate.quiet ? 'done' : 'working',
      prompt,
      updatedAt: now,
      stateStartedAt: now,
      stateHistory: []
    }
  ]
}

function worktree(id: string, repoId: string, name: string, branch: string) {
  return makeWorktree({ id, repoId, path: `/${name}`, displayName: name, branch })
}

function dialog(scrollToEnd: boolean) {
  return defineFixture({
    width: 640,
    interact: async (frame) => {
      await setRendererUiLanguage('en')
      // Why: the list scrolls, and the Can't restart group sits under the fold.
      if (scrollToEnd) {
        const tree = frame.ownerDocument.querySelector<HTMLElement>('[role="tree"]')
        tree?.scrollTo({ top: tree.scrollHeight })
      }
    },
    store: {
      worktreesByRepo: {
        'repo-1': [worktree(ORCA, 'repo-1', 'orca', 'refs/heads/feat/restart-agents')],
        'repo-2': [worktree(SITE, 'repo-2', 'landing-page', 'refs/heads/main')]
      },
      tabsByWorktree: {
        [ORCA]: candidates.slice(0, 2).map(tab),
        [SITE]: candidates.slice(2).map(tab)
      },
      agentStatusByPaneKey: acceptedAgentStatuses(prompts.map(status))
    },
    render: () => <RestartAgentSessionsPromptDialog prompt={{ id: 1, candidates }} />
  })
}

export const sessions = dialog(false)
export const scrolledToCantRestart = dialog(true)
