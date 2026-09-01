import { toast } from 'sonner'
import type { ManagedPane } from '@/lib/pane-manager/pane-manager'
import { launchAgentInNewTab } from '@/lib/launch-agent-in-new-tab'
import {
  buildAgentSessionForkPrompt,
  buildBoundedSessionTranscript
} from '@/lib/agent-session-fork-context'
import { activateAndRevealWorktree } from '@/lib/worktree-activation'
import { useAppStore } from '@/store'
import { makePaneKey } from '../../../../shared/stable-pane-id'
import { TUI_AGENT_CONFIG } from '../../../../shared/tui-agent-config'
import { isCustomTuiAgentId } from '../../../../shared/custom-tui-agent-identity'
import { slugifyForWorkspaceName } from '../../../../shared/workspace-name'
import { FLOATING_TERMINAL_WORKTREE_ID } from '../../../../shared/constants'
import type { CustomTuiAgent, TuiAgent } from '../../../../shared/types'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { getForkAgentLaunchPlatform, preflightForkAgentTrust } from './fork-agent-host-preflight'
import { translate } from '@/i18n/i18n'

type ForkAgentSessionFromPaneArgs = {
  pane: ManagedPane
  tabId: string
  worktreeId: string
  groupId: string | null
}

export type PreparedAgentSessionFork = {
  prompt: string
  agent: TuiAgent | null
  worktreeId: string
  pane: ManagedPane
  /** True when the source pane ran a custom agent whose definition is no longer
   *  live (deleted or unknown), so `agent` was filtered to null: the fork cannot
   *  relaunch it, and this flags the honest notice. */
  sourceWasCustomAgent: boolean
}

function buildForkWorkspaceName(sourceName: string): string {
  return slugifyForWorkspaceName(`${sourceName}-fork`) || 'session-fork'
}

function resolveTuiAgent(
  value: string | null | undefined,
  customTuiAgents: readonly CustomTuiAgent[] | null | undefined
): TuiAgent | null {
  if (value && Object.hasOwn(TUI_AGENT_CONFIG, value)) {
    return value as TuiAgent
  }
  // A custom id relaunches through the host agentLaunch boundary, which resolves
  // only live definitions — tombstoned/unknown ids degrade to the copy path.
  if (isCustomTuiAgentId(value) && customTuiAgents?.some((candidate) => candidate?.id === value)) {
    return value
  }
  return null
}

function getUsableForkBase(
  worktree:
    | { branch?: string | null; isArchived?: boolean; isBare?: boolean; repoId?: string }
    | null
    | undefined,
  repo: { kind?: string } | null | undefined,
  worktreeId: string
): string | null {
  const branch = worktree?.branch?.trim()
  if (
    worktreeId === FLOATING_TERMINAL_WORKTREE_ID ||
    !branch ||
    worktree?.isArchived ||
    worktree?.isBare ||
    !repo ||
    repo.kind === 'folder'
  ) {
    return null
  }
  return branch
}

async function copyForkContext(prompt: string, pane: ManagedPane): Promise<boolean> {
  try {
    await window.api.ui.writeTerminalClipboardText(prompt)
    toast.message(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.c00421d320',
        'Fork context copied. Launch an agent and paste it to start the fork.'
      )
    )
    pane.terminal.focus()
    return true
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.2317900211',
            'Failed to copy fork context.'
          )
    )
    pane.terminal.focus()
    return false
  }
}

export function prepareAgentSessionForkFromPane({
  pane,
  tabId,
  worktreeId
}: ForkAgentSessionFromPaneArgs): PreparedAgentSessionFork | null {
  const paneKey = makePaneKey(tabId, pane.leafId)
  const state = useAppStore.getState()
  const rawSourceAgent = state.agentStatusByPaneKey[paneKey]?.agentType
  const rawTabAgent = state.tabsByWorktree[worktreeId]?.find((tab) => tab.id === tabId)?.launchAgent
  const customTuiAgents = state.settings?.customTuiAgents
  const sourceAgent = resolveTuiAgent(rawSourceAgent, customTuiAgents)
  const tabAgent = resolveTuiAgent(rawTabAgent, customTuiAgents)
  const agent = sourceAgent ?? tabAgent
  // resolveTuiAgent nulls non-live custom ids; a null agent whose raw source was
  // a custom id means the source agent was deleted and fork cannot relaunch it.
  const sourceWasCustomAgent =
    !agent && (isCustomTuiAgentId(rawSourceAgent) || isCustomTuiAgentId(rawTabAgent))
  // Why: v1 is a context fork, not a process clone. Capturing scrollback keeps
  // SSH and local panes on the same path because both expose xterm state here.
  // The custom agent's display name, never the raw `custom-agent:<base>:<uuid>` id.
  const agentLabel =
    agent && isCustomTuiAgentId(agent)
      ? (customTuiAgents?.find((candidate) => candidate?.id === agent)?.label ?? null)
      : agent
  const prompt = buildAgentSessionForkPrompt({
    capturedText: pane.serializeAddon.serialize({ scrollback: 800 }),
    sourceLabel: paneKey,
    agentLabel
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
    pane,
    sourceWasCustomAgent
  }
}

export async function copyAgentSessionForkContext(
  fork: PreparedAgentSessionFork
): Promise<boolean> {
  return copyForkContext(fork.prompt, fork.pane)
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

export async function startAgentSessionFork(fork: PreparedAgentSessionFork): Promise<boolean> {
  const store = useAppStore.getState()
  const sourceWorktree = store.getKnownWorktreeById(fork.worktreeId)
  if (!sourceWorktree) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.f867385bb5',
        'Could not find the source workspace for this fork.'
      )
    )
    return false
  }
  const sourceRepo = store.repos.find((repo) => repo.id === sourceWorktree.repoId)
  const sourceProjectRuntime = getLocalProjectExecutionRuntimeContext(store, fork.worktreeId)
  const sourceBranch = getUsableForkBase(sourceWorktree, sourceRepo, fork.worktreeId)
  if (!sourceBranch) {
    toast.error(
      translate(
        'auto.components.terminal.pane.terminal.agent.session.fork.38e41edc6e',
        'This workspace cannot be forked into a git worktree.'
      )
    )
    return false
  }
  const forkName = buildForkWorkspaceName(sourceWorktree.displayName || sourceBranch)
  let created: Awaited<ReturnType<typeof store.createWorktree>>
  try {
    created = await store.createWorktree(
      sourceWorktree.repoId,
      forkName,
      sourceBranch,
      'inherit',
      undefined,
      'terminal_context_menu',
      `Fork of ${sourceWorktree.displayName || forkName}`,
      undefined,
      undefined,
      undefined,
      fork.agent ?? undefined
    )
  } catch (error) {
    toast.error(
      error instanceof Error
        ? error.message
        : translate(
            'auto.components.terminal.pane.terminal.agent.session.fork.fd3d12a1e1',
            'Failed to create fork workspace.'
          )
    )
    return false
  }
  // Fork does not request a host agent launch (U5 owns fork identity), so the
  // pre-create rejection arm cannot occur here; guard defensively to consume the
  // union without ever spawning a substitute primary.
  if (created.created === false) {
    return false
  }
  const forkWorktreeId = created.worktree.id

  if (!fork.agent) {
    activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })
    if (fork.sourceWasCustomAgent) {
      // A live custom agent forks like a built-in; only a deleted/unknown one
      // lands here. Name the limit instead of degrading with no explanation.
      toast.message(
        translate(
          'auto.components.terminal.pane.terminal.agent.session.fork.customForkAgentDeleted',
          'The custom agent from this session no longer exists, so the fork starts without an agent'
        )
      )
    }
    return copyAgentSessionForkContext(fork)
  }
  await preflightForkAgentTrust({
    agent: fork.agent,
    workspacePath: created.worktree.path,
    connectionId: sourceRepo?.connectionId
  })
  const launchPlatform = getForkAgentLaunchPlatform({
    repo: sourceRepo,
    worktreePath: created.worktree.path,
    projectRuntime: sourceProjectRuntime
  })
  // Why: a context fork is identity + scrollback-as-draft, not a provider-session
  // resume. It routes through the host `agentLaunch` boundary like every other
  // new-tab launch; `promptDelivery: 'draft'` lands the captured context
  // UNSUBMITTED so the user reviews before sending.
  launchAgentInNewTab({
    agent: fork.agent,
    worktreeId: forkWorktreeId,
    prompt: fork.prompt,
    promptDelivery: 'draft',
    launchSource: 'terminal_context_menu',
    ...(launchPlatform ? { launchPlatform } : {})
  })
  activateAndRevealWorktree(forkWorktreeId, { sidebarRevealBehavior: 'auto' })

  toast.success(
    translate(
      'auto.components.terminal.pane.terminal.agent.session.fork.88e34d00eb',
      'Top-level session fork opened in a new workspace'
    )
  )
  return true
}

export async function forkAgentSessionFromPane(args: ForkAgentSessionFromPaneArgs): Promise<void> {
  const fork = prepareAgentSessionForkFromPane(args)
  if (fork) {
    await startAgentSessionFork(fork)
  }
}
