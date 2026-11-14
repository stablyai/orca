import { useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY,
  AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY
} from '../../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { slugifyForWorkspaceName } from '../../../../../../../shared/workspace-name'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host'
import {
  nativeChatWorktreeForkPlan,
  nativeChatWorktreeForkSourceBranch,
  type NativeChatWorktreeForkBase
} from '../native-chat-worktree-fork'
import {
  defaultNativeChatForkAgent,
  nativeChatForkHostChoices,
  nativeChatForkRoute,
  nativeChatForkSubagentAllowed,
  nativeChatForkWindowStart,
  nativeChatForkWorkspaceKinds,
  type NativeChatForkRunAs,
  type NativeChatForkWindowPreset,
  type NativeChatForkWorkspaceChoice
} from './native-chat-fork-window-choices'
import type { NativeChatForkWindowSource } from './native-chat-fork-window-source'
import type { NativeChatForkWindowSelection } from './native-chat-fork-window-run'
import {
  useNativeChatForkHostWorktrees,
  useNativeChatForkHosts
} from './use-native-chat-fork-window-hosts'
import { useNativeChatForkAgents } from './use-native-chat-fork-window-agents'

/** Every field of the Fork window: what was picked, else its default, kept valid as other picks change. */
export function useNativeChatForkWindowState(
  source: NativeChatForkWindowSource,
  preset: NativeChatForkWindowPreset
) {
  const sourceHostId = getRuntimeTargetHostId(source.target)
  const start = nativeChatForkWindowStart(preset, source.newWorktreeOffered)
  const [plan] = useState(() => nativeChatWorktreeForkPlan(source.worktreeId))
  const [hostPick, setHostPick] = useState<ExecutionHostId>(sourceHostId)
  const [agentPick, setAgentPick] = useState<TuiAgent | null>(null)
  const [workspacePick, setWorkspacePick] = useState<NativeChatForkWorkspaceChoice>(start.workspace)
  const [runAsPick, setRunAsPick] = useState<NativeChatForkRunAs>(start.runAs)
  const [name, setName] = useState(plan?.name ?? '')
  const [base, setBase] = useState<NativeChatWorktreeForkBase>('main')
  const [task, setTask] = useState('')
  const preferred = useAppStore((state) => state.settings?.defaultTuiAgent)
  const exportState = useStructuredAgentSessionHostCapabilityState(
    source.target,
    AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY
  )
  const hosts = useNativeChatForkHosts()
  const pickedWorktrees = useNativeChatForkHostWorktrees(hostPick, source.worktreeId)
  // Another workspace defaults to the host's first one by name.
  const pickedExisting =
    workspacePick.kind === 'existing'
      ? ((
          pickedWorktrees.find((worktree) => worktree.id === workspacePick.worktreeId) ??
          pickedWorktrees[0]
        )?.id ?? null)
      : null
  const { agents, detecting } = useNativeChatForkAgents(
    pickedExisting ?? (hostPick === sourceHostId ? source.worktreeId : null),
    source.agent
  )
  const agent =
    agentPick && agents.includes(agentPick)
      ? agentPick
      : defaultNativeChatForkAgent({
          sourceAgent: source.agent,
          usageLimited: source.usageLimited,
          available: agents,
          preferred: isTuiAgent(preferred) ? preferred : null
        })
  const hostChoices = nativeChatForkHostChoices({
    sourceHostId,
    hosts,
    copiesHistory: agent === source.agent,
    sourceCanExport: source.agent === 'claude' && exportState === 'supported',
    importCapability: AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY
  })
  const host =
    hostChoices.find((choice) => choice.id === hostPick && !choice.disabled) ?? hostChoices[0]
  // An exact copy this host can't export stays here; picking another agent opens the other hosts.
  const otherHostsNeedAnotherAgent =
    hostChoices.length === 1 &&
    agents.length > 1 &&
    hosts.some((choice) => choice.id !== sourceHostId)
  const sameHost = host.id === sourceHostId
  const route = nativeChatForkRoute({
    sourceHostId,
    hostId: host.id,
    sourceAgent: source.agent,
    agent
  })
  const workspaceKinds = nativeChatForkWorkspaceKinds({
    sameHost,
    route,
    newWorktreeOffered: source.newWorktreeOffered,
    destinationOffered: source.destinationOffered
  })
  // A host that can't take this fork falls back to the source, whose workspaces were not picked.
  const existingId = host.id === hostPick ? pickedExisting : null
  const kind = workspaceKinds.includes(workspacePick.kind) ? workspacePick.kind : workspaceKinds[0]
  const workspace: NativeChatForkWorkspaceChoice =
    kind === 'existing' ? { kind, worktreeId: existingId ?? '' } : { kind: kind ?? 'this' }
  const subagentAllowed = nativeChatForkSubagentAllowed({
    route,
    subagentOffered: source.subagentOffered,
    workspace
  })
  const runAs: NativeChatForkRunAs = subagentAllowed ? runAsPick : 'open'
  const slug = slugifyForWorkspaceName(name)
  // At a usage limit the default agent is only known once detection answers; Enter waits for it.
  const ready =
    !(detecting && source.usageLimited) &&
    (workspace.kind !== 'existing' || existingId !== null) &&
    (workspace.kind !== 'new-worktree' || slug.length > 0) &&
    (runAs !== 'subagent' || task.trim().length > 0)
  const selection = (throughItemId: string, draft?: string): NativeChatForkWindowSelection => ({
    throughItemId,
    ...(draft && runAs === 'open' ? { draft } : {}),
    sourceHostId,
    hostId: host.id,
    hostLabel: host.label,
    agent,
    workspace,
    runAs,
    // The person's name is the title; the default keeps its "Fork N of" wording.
    newWorktree: {
      name: slug,
      displayName: slug === plan?.name ? plan.displayName : name.trim(),
      base
    },
    task: task.trim()
  })
  return {
    route,
    host,
    hostChoices,
    selectHost: (hostId: string) => {
      const picked = hostChoices.find((choice) => choice.id === hostId)
      // Re-picking the current host keeps the workspace already chosen there.
      if (picked && picked.id !== host.id) {
        setHostPick(picked.id)
        setWorkspacePick(
          picked.id === sourceHostId ? start.workspace : { kind: 'existing', worktreeId: '' }
        )
      }
    },
    workspaceKinds,
    workspace,
    worktrees: host.id === hostPick ? pickedWorktrees : [],
    setWorkspace: setWorkspacePick,
    agents,
    agent,
    detecting,
    otherHostsNeedAnotherAgent,
    setAgent: setAgentPick,
    runAs,
    subagentAllowed,
    setRunAs: setRunAsPick,
    worktree: {
      name,
      setName,
      slug,
      base,
      setBase,
      branch: nativeChatWorktreeForkSourceBranch(source.worktreeId)
    },
    task,
    setTask,
    ready,
    selection
  }
}
