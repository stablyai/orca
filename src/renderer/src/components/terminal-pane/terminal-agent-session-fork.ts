import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import {
  buildAgentSessionForkPrompt,
  buildBoundedSessionTranscript
} from '@/lib/agent-session-fork-context'
import { useAppStore } from '@/store'
import { listForkableAgentSessions } from '@/lib/worktree-agent-fork-sessions'
import { findForkWorktreeRepo } from '@/lib/agent-session-fork-source-repo'
import { buildAgentSessionForkModalData } from '@/components/agent-session-fork/agent-session-fork-modal-data'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { isTuiAgent } from '../../../../shared/tui-agent-config'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'

type ForkAgentSessionFromPaneArgs = {
  pane: ManagedPane
  tabId: string
  worktreeId: string
}

type PreparedAgentSessionFork = {
  prompt: string
  agent: TuiAgent | null
}

function resolveTuiAgent(value: string | null | undefined): TuiAgent | null {
  return isTuiAgent(value) ? value : null
}

// Why: the terminal menu is not gated, so block sources the fork dialog cannot turn into a git worktree.
function ensureForkableSourceWorkspace(worktreeId: string, pane: ManagedPane): boolean {
  const state = useAppStore.getState()
  const worktree = state.getKnownWorktreeById(worktreeId)
  if (!worktree) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.f867385bb5',
        'Could not find the source workspace for this fork.'
      )
    )
    pane.terminal.focus()
    return false
  }
  const repo = findForkWorktreeRepo(state, worktree)
  const forkable =
    worktreeId !== FLOATING_TERMINAL_WORKTREE_ID &&
    Boolean(worktree.branch?.trim()) &&
    !worktree.isArchived &&
    !worktree.isBare &&
    Boolean(repo) &&
    repo?.kind !== 'folder'
  if (!forkable) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
        'This workspace cannot be forked into a git worktree.'
      )
    )
    pane.terminal.focus()
  }
  return forkable
}

function prepareAgentSessionForkFromPane({
  pane,
  tabId,
  worktreeId
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
  return prompt ? { prompt, agent } : null
}

// Why: the standalone "Copy Context" action copies the bounded transcript on its
// own — for pasting into another tool — so it must not carry the fork prompt's
// "this is a fork… acknowledge and wait" framing the dialog button uses.
export async function copyAgentSessionContextFromPane(pane: ManagedPane): Promise<boolean> {
  const transcript = buildBoundedSessionTranscript(
    pane.serializeAddon.serialize({ scrollback: 800 })
  )
  if (!transcript) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.f62b40e2c7',
        'No terminal context to copy'
      )
    )
    pane.terminal.focus()
    return false
  }
  try {
    await window.api.ui.writeTerminalClipboardText(transcript)
    toast.message(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.373a3103e7',
        'Context copied'
      )
    )
    pane.terminal.focus()
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.3fc568a49d',
            'Failed to copy context.'
          )
    )
    pane.terminal.focus()
    return false
  }
}

export function openAgentSessionForkDialogFromPane(args: ForkAgentSessionFromPaneArgs): void {
  const { pane, tabId, worktreeId } = args
  if (!ensureForkableSourceWorkspace(worktreeId, pane)) {
    return
  }
  const paneKey = makePaneKey(tabId, pane.leafId)
  // Why: a native fork resumes the provider session, so it needs no captured scrollback and
  // the dialog drops the transcript option for it anyway.
  const hasNativeFork = listForkableAgentSessions(useAppStore.getState(), worktreeId).some(
    (session) => session.paneKey === paneKey
  )
  // Why: an empty scrollback still allows a branch-only fork through "No agent".
  const fork = hasNativeFork ? null : prepareAgentSessionForkFromPane(args)
  useAppStore.getState().openModal(
    'agent-session-fork',
    buildAgentSessionForkModalData({
      sourceWorktreeId: worktreeId,
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: paneKey,
      transcript: fork
    })
  )
}
