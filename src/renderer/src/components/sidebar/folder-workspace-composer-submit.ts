import type { LinkedWorkItemSummary } from '@/lib/new-workspace'
import { resolveQuickCreateLinkedWorkItemPrompt } from '@/lib/linked-work-item-context'
import { seedNativeChatLaunchDraftForAgentTab } from '@/lib/agent-launch-prompt-delivery'
import {
  activateAndRevealFolderWorkspace,
  type WorktreeStartupPayload
} from '@/lib/worktree-activation'
import { isWorkItemLookupText } from '@/lib/work-item-lookup-text'
import { assertRuntimeSupportsAgentLaunchIdentity } from '@/runtime/agent-launch-identity-negotiation'
import { useAppStore } from '@/store'
import { resolveTuiAgentConfig } from '../../../../shared/custom-tui-agents'
import type { AgentLaunchSpawnRequest } from '../../../../shared/agent-launch-spawn-request'
import type { FolderWorkspace, ProjectGroup, TuiAgent } from '../../../../shared/types'
import type { LaunchSource } from '../../../../shared/telemetry-events'
import type { TaskSourceContext } from '../../../../shared/task-source-context'
import {
  getLinkedItemDisplayName,
  toFolderWorkspaceLinkedTask
} from './folder-workspace-composer-helpers'

type FolderWorkspaceCreateInput = {
  projectGroupId: string
  name: string
  connectionId?: string | null
  linkedTask: FolderWorkspace['linkedTask']
  linkedTaskSourceContext?: TaskSourceContext | null
  createdWithAgent?: TuiAgent
  pendingFirstAgentMessageRename?: boolean
}

type SubmitFolderWorkspaceCreateParams = {
  projectGroup: ProjectGroup
  name: string
  lastAutoName: string
  linkedWorkItem: LinkedWorkItemSummary | null
  linkedTaskSourceContext?: TaskSourceContext | null
  note: string
  quickAgent: TuiAgent | null
  autoRenameBranchFromWork: boolean | undefined
  launchSource?: LaunchSource
  runtimeEnvironmentId?: string | null
  createFolderWorkspace: (input: FolderWorkspaceCreateInput) => Promise<FolderWorkspace | null>
  onOpenChange: (open: boolean) => void
}

/**
 * Identity-only host launch for a folder-workspace agent. The host resolves the
 * command/args/env, folds the prompt or picks native-flag vs post-ready paste
 * for the draft, and the pty-connection paste writer delivers any host-returned
 * followup/draft — so the renderer names only the requested agent and the
 * draft-vs-submit intent. A linked work item seeds a reviewable draft; a plain
 * note folds into the launch (submitted as the first turn).
 */
function buildFolderWorkspaceStartup(args: {
  agent: TuiAgent
  linkedWorkItem: LinkedWorkItemSummary | null
  note: string
  launchSource: LaunchSource
}): WorktreeStartupPayload {
  const { agent, linkedWorkItem, note, launchSource } = args
  const { prompt: quickPrompt, draftPrompt } = linkedWorkItem
    ? resolveQuickCreateLinkedWorkItemPrompt(linkedWorkItem, note)
    : { prompt: note, draftPrompt: undefined }
  // Why: a linked work item always launches as a reviewable draft; the resolver
  // may hand back a formatted draft or, failing that, the plain prompt text.
  const linkedDraft = linkedWorkItem ? (draftPrompt ?? quickPrompt.trim()) || null : null
  const agentLaunch: AgentLaunchSpawnRequest = linkedDraft
    ? { selection: { kind: 'agent', agent }, prompt: linkedDraft, promptDelivery: 'draft' }
    : {
        selection: { kind: 'agent', agent },
        ...(quickPrompt.trim() ? { prompt: quickPrompt } : {}),
        allowEmptyPromptLaunch: true
      }
  return {
    command: '',
    launchAgent: agent,
    agentLaunch,
    ...(linkedDraft ? { launchDraftText: linkedDraft } : {}),
    // Host overwrites agent_kind from the resolved receipt before the emit, so
    // this host-resolved launch threads only the surface-owned fields.
    telemetry: {
      launch_source: launchSource,
      request_kind: 'new'
    }
  }
}

async function preflightFolderWorkspaceAgentTrust(args: {
  agent: TuiAgent | null
  workspacePath: string | null
  connectionId?: string | null
}): Promise<void> {
  if (!args.agent || !window.api.agentTrust?.markTrusted) {
    return
  }
  // Why: a custom id inherits its base harness's trust preset, so resolve the
  // base before reading the built-in-only config — a raw custom id would index
  // an undefined entry and crash (noImplicitAny hides it); a tombstoned/unknown
  // id degrades to no preflight.
  const { settings } = useAppStore.getState()
  const preflight = resolveTuiAgentConfig(
    args.agent,
    settings?.customTuiAgents,
    settings?.deletedCustomTuiAgents
  )?.preflightTrust
  if (!preflight || !args.workspacePath) {
    return
  }
  try {
    await window.api.agentTrust.markTrusted({
      preset: preflight,
      workspacePath: args.workspacePath,
      ...(args.connectionId ? { connectionId: args.connectionId } : {})
    })
  } catch {
    // Best-effort: the user can still accept the agent trust prompt manually.
  }
}

export async function submitFolderWorkspaceCreate({
  projectGroup,
  name,
  lastAutoName,
  linkedWorkItem,
  linkedTaskSourceContext,
  note,
  quickAgent,
  autoRenameBranchFromWork,
  launchSource = 'sidebar',
  runtimeEnvironmentId = null,
  createFolderWorkspace,
  onOpenChange
}: SubmitFolderWorkspaceCreateParams): Promise<boolean> {
  // Why: this launch carries no client-assembled command, so a pre-identity host
  // would strip agentLaunch, open a blank shell and drop the note/linked draft.
  // Refuse before creating anything — the composer stays open with the note.
  if (quickAgent && runtimeEnvironmentId) {
    await assertRuntimeSupportsAgentLaunchIdentity(runtimeEnvironmentId)
  }
  const linkedName = linkedWorkItem ? getLinkedItemDisplayName(linkedWorkItem) : null
  const nameIsAutoManaged = !name.trim() || name === lastAutoName || isWorkItemLookupText(name)
  const workspaceName =
    nameIsAutoManaged && linkedName
      ? linkedName
      : name.trim() || linkedName || `${projectGroup.name} workspace`
  // Why: the pending badge should only appear when the submitted prompt can
  // actually produce the first agent message that names the workspace.
  const pendingFirstAgentMessageRename =
    autoRenameBranchFromWork === true &&
    !name.trim() &&
    !linkedWorkItem &&
    Boolean(quickAgent) &&
    note.trim().length > 0

  const workspace = await createFolderWorkspace({
    projectGroupId: projectGroup.id,
    name: workspaceName,
    // Why: SSH folder groups must keep their target provenance even when the
    // focused runtime is local or another host.
    connectionId: projectGroup.connectionId ?? null,
    linkedTask: toFolderWorkspaceLinkedTask(linkedWorkItem),
    ...(linkedTaskSourceContext ? { linkedTaskSourceContext } : {}),
    ...(quickAgent ? { createdWithAgent: quickAgent } : {}),
    ...(pendingFirstAgentMessageRename ? { pendingFirstAgentMessageRename: true } : {})
  })
  if (!workspace) {
    return false
  }
  await preflightFolderWorkspaceAgentTrust({
    agent: quickAgent,
    workspacePath: workspace.folderPath,
    connectionId: workspace.connectionId ?? projectGroup.connectionId
  })

  const startup = quickAgent
    ? buildFolderWorkspaceStartup({ agent: quickAgent, linkedWorkItem, note, launchSource })
    : undefined
  onOpenChange(false)
  try {
    const activation = activateAndRevealFolderWorkspace(workspace.id, {
      ...(startup ? { startup } : {}),
      runtimeEnvironmentId
    })
    if (activation && activation.primaryTabId && startup?.launchDraftText && quickAgent) {
      seedNativeChatLaunchDraftForAgentTab({
        tabId: activation.primaryTabId,
        agent: quickAgent,
        text: startup.launchDraftText
      })
    }
  } catch (error) {
    // Why: creation already succeeded. Do not leave the completed create modal
    // open if the follow-up reveal/startup path hits a transient issue.
    console.error('Failed to activate folder workspace after create:', error)
  }
  return true
}
