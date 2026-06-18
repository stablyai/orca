import { toast } from 'sonner'
import { buildAgentSessionForkPrompt } from '@/lib/agent-session-fork-context'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import type { TuiAgent } from '../../../../shared/types'
import { startAgentSessionFork } from './terminal-agent-session-fork-launch'

export {
  copyAgentSessionForkContext,
  startAgentSessionFork
} from './terminal-agent-session-fork-launch'
export { preflightAgentSessionFork } from './terminal-agent-session-fork-runtime'

type ForkAgentSessionFromPaneArgs = {
  pane: ManagedPane
  tabId: string
  worktreeId: string
  groupId: string | null
  terminalHandle?: string | null
}

export type StartAgentSessionForkOptions = {
  activate?: boolean
  message?: string
  name?: string
  noCopyFiles?: boolean
}

export type PreflightAgentSessionForkOptions = {
  message?: string
  noCopyFiles?: boolean
}

export type PreparedAgentSessionFork = {
  prompt: string
  agent: TuiAgent | null
  worktreeId: string
  groupId: string | null
  terminalHandle: string | null
  pane: ManagedPane
}

function resolveTuiAgent(value: string | null | undefined): TuiAgent | null {
  return value && Object.prototype.hasOwnProperty.call(TUI_AGENT_CONFIG, value)
    ? (value as TuiAgent)
    : null
}

export function prepareAgentSessionForkFromPane({
  pane,
  tabId,
  worktreeId,
  groupId,
  terminalHandle = null
}: ForkAgentSessionFromPaneArgs): PreparedAgentSessionFork | null {
  const paneKey = makePaneKey(tabId, pane.leafId)
  const state = useAppStore.getState()
  const sourceAgent = resolveTuiAgent(state.agentStatusByPaneKey[paneKey]?.agentType)
  const tabAgent = resolveTuiAgent(
    state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.launchAgent
  )
  const agent = sourceAgent ?? tabAgent
  // Why: v1 is a context fork, not a process clone. Capturing scrollback keeps
  // SSH and local panes on the same path because both expose xterm state here.
  const prompt = buildAgentSessionForkPrompt({
    capturedText: pane.serializeAddon.serialize({ scrollback: 800 }),
    sourceLabel: paneKey,
    agentLabel: agent
  })

  if (!prompt) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.046e8d853c',
        'No terminal context to fork'
      )
    )
    pane.terminal.focus()
    return null
  }

  return {
    prompt,
    agent,
    worktreeId,
    groupId,
    terminalHandle,
    pane
  }
}

export async function forkAgentSessionFromPane(args: ForkAgentSessionFromPaneArgs): Promise<void> {
  const fork = prepareAgentSessionForkFromPane(args)
  if (fork) {
    await startAgentSessionFork(fork)
  }
}
