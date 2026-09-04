import { toast } from 'sonner'
import { reconcileTabOrder } from '@/components/tab-bar/reconcile-order'
import { translate } from '@/i18n/i18n'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from '@/lib/new-workspace'
import {
  getExecutionHostIdForWorktree,
  getRuntimeEnvironmentIdForWorktree
} from '@/lib/worktree-runtime-owner'
import { useAppStore } from '@/store'
import { worktreeUsesWslPath } from '@/store/terminals/terminal-workspace-routing'
import { repoIsRemote } from '../../../shared/agent-launch-remote'
import {
  buildCustomAgentLaunch,
  isCustomAgentProfileEnabled,
  normalizeCustomAgentProfiles
} from '../../../shared/custom-agent-profile'
import { parseExecutionHostId } from '../../../shared/execution-host'
import { resolveStartupShell } from '../../../shared/tui-agent-startup-shell'
import { resolveLocalWindowsAgentStartupShell } from '../../../shared/windows-terminal-shell'

export function launchCustomAgentInNewTab(args: {
  profileId: string
  worktreeId: string
  groupId?: string
}): { tabId: string } | null {
  const store = useAppStore.getState()
  const profile = normalizeCustomAgentProfiles(store.settings?.customAgentProfiles).find(
    (candidate) => candidate.id === args.profileId
  )
  if (!profile) {
    toast.error(
      translate(
        'auto.lib.launchCustomAgentInNewTab.profileRemoved',
        'This custom agent was removed. Choose another agent.'
      )
    )
    return null
  }
  if (!isCustomAgentProfileEnabled(profile)) {
    toast.error(
      translate(
        'auto.lib.launchCustomAgentInNewTab.profileDisabled',
        'This custom agent is disabled. Enable it in Agent settings to launch it.'
      )
    )
    return null
  }

  const environmentId = getRuntimeEnvironmentIdForWorktree(store, args.worktreeId)
  const executionHost = parseExecutionHostId(getExecutionHostIdForWorktree(store, args.worktreeId))
  if (executionHost?.kind === 'runtime') {
    toast.error(
      translate(
        'auto.lib.launchCustomAgentInNewTab.pairedRuntimeUnsupported',
        'Custom agents are not yet available on paired Orca hosts.'
      )
    )
    return null
  }

  const sshPlatform =
    executionHost?.kind === 'ssh'
      ? environmentId
        ? store.sshStateByEnvironment
            .get(environmentId)
            ?.connectionStates.get(executionHost.targetId)?.remotePlatform
        : store.sshConnectionStates.get(executionHost.targetId)?.remotePlatform
      : null
  if (executionHost?.kind === 'ssh' && !sshPlatform) {
    toast.error(
      translate(
        'auto.lib.launchCustomAgentInNewTab.sshUnavailable',
        'Reconnect the SSH target before launching a custom agent.'
      )
    )
    return null
  }
  if (sshPlatform === 'win32') {
    toast.error(
      translate(
        'auto.lib.launchCustomAgentInNewTab.windowsSshUnsupported',
        'Custom agents are not yet available over Windows SSH.'
      )
    )
    return null
  }

  const worktree = store
    .allWorktrees?.()
    .find((entry: { id: string }) => entry.id === args.worktreeId)
  const repo = worktree ? store.repos?.find((entry) => entry.id === worktree.repoId) : null
  const platform =
    sshPlatform ??
    (repo
      ? getAgentLaunchPlatformForRepo(
          repo,
          repo.connectionId
            ? undefined
            : getLocalProjectExecutionRuntimeContext(store, args.worktreeId)
        )
      : worktreeUsesWslPath(store, args.worktreeId)
        ? 'linux'
        : CLIENT_PLATFORM)
  const isRemote = repo ? repoIsRemote(repo) : false
  const shell = resolveStartupShell(
    platform,
    resolveLocalWindowsAgentStartupShell({
      platform,
      isRemote,
      terminalWindowsShell: store.settings?.terminalWindowsShell
    })
  )
  const launch = buildCustomAgentLaunch(profile, shell)

  const tab = store.createTab(args.worktreeId, args.groupId, undefined, {
    ...(profile.baseAgent ? { launchAgent: profile.baseAgent } : {}),
    quickCommandLabel: profile.name,
    viewMode: 'terminal'
  })
  store.queueTabStartupCommand(tab.id, {
    command: launch.command,
    ...(launch.env ? { env: launch.env } : {}),
    ...(profile.baseAgent ? { launchAgent: profile.baseAgent } : {})
  })
  store.setActiveTabType('terminal')
  const fresh = useAppStore.getState()
  const terminalIds = (fresh.tabsByWorktree[args.worktreeId] ?? []).map((entry) => entry.id)
  const editorIds = fresh.openFiles
    .filter((entry) => entry.worktreeId === args.worktreeId)
    .map((entry) => entry.id)
  const browserIds = (fresh.browserTabsByWorktree?.[args.worktreeId] ?? []).map((entry) => entry.id)
  const order = reconcileTabOrder(
    fresh.tabBarOrderByWorktree[args.worktreeId],
    terminalIds,
    editorIds,
    browserIds
  ).filter((id) => id !== tab.id)
  order.push(tab.id)
  fresh.setTabBarOrder(args.worktreeId, order)
  return { tabId: tab.id }
}
