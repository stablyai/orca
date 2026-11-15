import { useEffect, useState } from 'react'
import { useAppStore } from '@/store'
import { getRuntimeTargetHostId } from '@/runtime/rpc/targets/runtime-client-target'
import { useStructuredAgentSessionHostCapabilityState } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-capability'
import { isTuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent-config'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import {
  AI_VAULT_CHAT_FORK_EXPORT_CAPABILITY,
  AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY
} from '../../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { slugifyForWorkspaceName } from '../../../../../../../shared/workspace/naming/workspace-name'
import type { ExecutionHostId } from '../../../../../../../shared/execution-host'
import {
  nativeChatWorktreeForkPlan,
  nativeChatWorktreeForkSourceBranch,
  type NativeChatWorktreeForkBase
} from '../native-chat-worktree-fork'
import {
  chatForkPath,
  chatForkSurfaceChoice,
  type ChatForkSurface
} from '../../../../../../../shared/native-chat/chat-fork-path'
import type { ChatForkRecapScope } from '../../../../../../../shared/agent-session/context/chat-fork-recap'
import {
  nativeChatForkAgent,
  nativeChatForkHostChoices,
  nativeChatForkSubagentAllowed,
  nativeChatForkSurfaces,
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
  const [start] = useState(() => nativeChatForkWindowStart(preset, source.newWorktreeOffered))
  const [plan] = useState(() => nativeChatWorktreeForkPlan(source.worktreeId))
  const [hostPick, setHostPick] = useState<ExecutionHostId>(sourceHostId)
  const [agentPick, setAgentPick] = useState<TuiAgent | null>(null)
  const [workspacePick, setWorkspacePick] = useState<NativeChatForkWorkspaceChoice>(start.workspace)
  const [runAsPick, setRunAsPick] = useState<NativeChatForkRunAs>(start.runAs)
  const [name, setName] = useState(plan?.name ?? '')
  const [base, setBase] = useState<NativeChatWorktreeForkBase>('main')
  const [task, setTask] = useState('')
  const [surfacePick, setSurfacePick] = useState<ChatForkSurface | undefined>(undefined)
  const [recapScope, setRecapScope] = useState<ChatForkRecapScope>('history')
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
  const { agents, chatAgents, cliAgents, detecting } = useNativeChatForkAgents(
    pickedExisting ?? (hostPick === sourceHostId ? source.worktreeId : null),
    source.agent
  )
  // A picked agent outlives the detection a host or workspace change restarts; Enter waits for it.
  const { agent, settled } = nativeChatForkAgent({
    picked: agentPick,
    sourceAgent: source.agent,
    usageLimited: source.usageLimited,
    available: agents,
    preferred: isTuiAgent(preferred) ? preferred : null,
    detecting
  })
  const hostChoices = nativeChatForkHostChoices({ sourceHostId, hosts })
  const host =
    hostChoices.find((choice) => choice.id === hostPick && !choice.disabled) ??
    hostChoices.find((choice) => !choice.disabled) ??
    hostChoices[0]
  // A picked host that went offline (or can't take this fork) hands its place to the fallback.
  useEffect(() => {
    if (host.id !== hostPick) {
      setHostPick(host.id)
      setWorkspacePick(
        host.id === sourceHostId ? start.workspace : { kind: 'existing', worktreeId: '' }
      )
    }
  }, [host.id, hostPick, sourceHostId, start.workspace])
  const sameHost = host.id === sourceHostId
  const sourceSurface: ChatForkSurface = source.kind === 'terminal' ? 'terminal' : 'chat'
  const surfaces = nativeChatForkSurfaces({
    sourceSurface,
    sameHost,
    sameAgent: agent === source.agent,
    agent,
    chatAgents,
    cliAgents
  })
  const openAs = chatForkSurfaceChoice({ sourceSurface, picked: surfacePick, available: surfaces })
  // Only Claude's history moves between hosts and kinds; the target must import it.
  const relays =
    source.agent === 'claude' &&
    source.sessionId !== '' &&
    exportState === 'supported' &&
    hosts.some(
      (entry) =>
        entry.id === host.id && entry.capabilities?.includes(AI_VAULT_CHAT_FORK_IMPORT_CAPABILITY)
    )
  const route = chatForkPath({
    sameAgent: agent === source.agent,
    sameHost,
    sameSurface: openAs === sourceSurface,
    cutsHere: source.cutsHere,
    relays
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
  const ready =
    !host.disabled &&
    openAs !== null &&
    settled &&
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
    route,
    openAs: openAs ?? sourceSurface,
    recapScope,
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
      if (picked && !picked.disabled && picked.id !== hostPick) {
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
    setAgent: setAgentPick,
    surfaces,
    openAs,
    setOpenAs: setSurfacePick,
    recapScope,
    setRecapScope,
    /** Why the same agent gets a recap: no exact copy reaches this kind or host. */
    sameAgentRecap:
      route !== 'recap' || agent !== source.agent
        ? null
        : source.agent !== 'claude' || source.sessionId === ''
          ? ('agent' as const)
          : exportState !== 'supported'
            ? ('source-host' as const)
            : ('target-host' as const),
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
