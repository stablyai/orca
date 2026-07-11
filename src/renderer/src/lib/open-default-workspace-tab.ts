import type { TuiAgent, Worktree } from '../../../shared/types'
import type { BuiltInWindowsTerminalShell } from '../../../shared/windows-terminal-shell'
import type { DefaultWorkspaceTab } from '../../../shared/default-workspace-tab'
import type { WorktreeStartupPayload } from './worktree-activation'
import type { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { shouldAutoCreateInitialTerminal } from '@/components/terminal/initial-terminal'
import { getRuntimeEnvironmentIdForWorktree } from '@/lib/worktree-runtime-owner'
import { isWebRuntimeSessionActive } from '@/runtime/web-runtime-session'
import { getCachedWindowsTerminalCapabilities } from '@/lib/windows-terminal-capabilities'
import { resolveWindowsShellLaunchTarget } from '@/components/tab-bar/windows-shell-launch'
import { getAgentLaunchPlatformForRepo } from '@/lib/agent-launch-platform'
import { getLocalProjectExecutionRuntimeContext } from '@/lib/local-preflight-context'
import { CLIENT_PLATFORM } from './new-workspace'
import { tuiAgentToAgentKind } from './telemetry'
import { buildAgentStartupPlan } from './tui-agent-startup'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { repoIsRemote } from '../../../shared/agent-launch-remote'

type WorkspaceSurfaceStore = ReturnType<typeof useAppStore.getState>

/**
 * How the configurable default surface for a first workspace activation should
 * be realized. `terminal` feeds the existing initial-terminal path (optionally
 * with an agent startup or a specific shell); `created` means a non-terminal
 * surface was opened directly; `fallback-terminal` means the chosen surface is
 * not creatable on this host and the caller should open a plain terminal.
 */
export type DefaultWorkspaceSurfaceOutcome =
  | { kind: 'terminal'; startup?: WorktreeStartupPayload; shellOverride?: string }
  | { kind: 'created'; tabId: string }
  | { kind: 'fallback-terminal' }

/**
 * Builds the agent-launch startup payload used to seed a workspace's first
 * terminal with a coding agent. Shared by the "created with agent" reopen path
 * and the default-workspace-tab agent option so both launch identically.
 */
export function buildSidebarAgentStartup(
  store: WorkspaceSurfaceStore,
  worktree: Worktree,
  agent: TuiAgent,
  requestKind: 'new' | 'resume'
): WorktreeStartupPayload | undefined {
  const repo = store.repos.find((entry) => entry.id === worktree.repoId)
  const launchPlatform = repo
    ? getAgentLaunchPlatformForRepo(
        repo,
        repo.connectionId ? undefined : getLocalProjectExecutionRuntimeContext(store, worktree.id)
      )
    : CLIENT_PLATFORM

  const startupPlan = buildAgentStartupPlan({
    agent,
    prompt: '',
    cmdOverrides: store.settings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(agent, store.settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(agent, store.settings?.agentDefaultEnv),
    platform: launchPlatform,
    isRemote: repo ? repoIsRemote(repo) : false,
    allowEmptyPromptLaunch: true
  })
  if (!startupPlan) {
    return undefined
  }

  return {
    command: startupPlan.launchCommand,
    ...(startupPlan.env ? { env: startupPlan.env } : {}),
    launchConfig: startupPlan.launchConfig,
    launchAgent: agent,
    ...(startupPlan.startupCommandDelivery
      ? { startupCommandDelivery: startupPlan.startupCommandDelivery }
      : {}),
    telemetry: {
      agent_kind: tuiAgentToAgentKind(agent),
      launch_source: 'sidebar',
      request_kind: requestKind
    }
  }
}

// Why: shellOverride is a raw shell token spawned on the worktree's host. We can
// only be sure that host is Windows for a local worktree on a Windows client;
// remote/SSH hosts have an unknown platform, so they fall back to a plain
// terminal rather than risk spawning an invalid shell.
function resolveDefaultTerminalShellOverride(
  store: WorkspaceSurfaceStore,
  worktree: Worktree,
  shell: BuiltInWindowsTerminalShell
): string | undefined {
  const repo = store.repos.find((entry) => entry.id === worktree.repoId)
  const isLocalWorktree =
    !getRuntimeEnvironmentIdForWorktree(store, worktree.id) && !(repo ? repoIsRemote(repo) : false)
  if (!isLocalWorktree || !navigator.userAgent.includes('Windows')) {
    return undefined
  }
  const implementation = store.settings?.terminalWindowsPowerShellImplementation ?? 'auto'
  const pwshAvailable = getCachedWindowsTerminalCapabilities().pwshAvailable
  return resolveWindowsShellLaunchTarget(shell, implementation, pwshAvailable)
}

// Why: only open a non-terminal default when the worktree truly has no surface
// yet (matching the initial-terminal auto-create guard) and is not a runtime-
// mirrored web session, whose host owns tab creation.
function canCreateNonTerminalDefaultSurface(
  store: WorkspaceSurfaceStore,
  worktreeId: string
): boolean {
  if (isWebRuntimeSessionActive(getRuntimeEnvironmentIdForWorktree(store, worktreeId))) {
    return false
  }
  const { renderableTabCount } = store.reconcileWorktreeTabModel(worktreeId)
  return shouldAutoCreateInitialTerminal(renderableTabCount)
}

function createDefaultBrowserSurface(
  store: WorkspaceSurfaceStore,
  worktreeId: string
): string | null {
  const defaultUrl = store.browserDefaultUrl ?? 'about:blank'
  const browserTab = store.createBrowserTab(worktreeId, defaultUrl, {
    title: translate('auto.store.slices.browser.d175274b6d', 'New Browser Tab'),
    focusAddressBar: true,
    activate: true
  })
  return browserTab.id
}

/**
 * Resolves the user's configured default-workspace-tab into a concrete surface
 * for the first activation of a worktree. Reuses the same store methods as the
 * "+" new-tab menu (agent startup, `createBrowserTab`) so the default stays
 * consistent with manual creation; any surface that cannot be created on the
 * current host degrades to a plain terminal.
 */
export function resolveDefaultWorkspaceSurface(
  store: WorkspaceSurfaceStore,
  worktree: Worktree,
  descriptor: DefaultWorkspaceTab
): DefaultWorkspaceSurfaceOutcome {
  switch (descriptor.kind) {
    case 'terminal':
      return { kind: 'terminal' }
    case 'terminal-shell':
      return {
        kind: 'terminal',
        shellOverride: resolveDefaultTerminalShellOverride(store, worktree, descriptor.shell)
      }
    case 'agent':
      return {
        kind: 'terminal',
        startup: buildSidebarAgentStartup(store, worktree, descriptor.agent, 'new')
      }
    case 'browser': {
      if (!canCreateNonTerminalDefaultSurface(store, worktree.id)) {
        return { kind: 'fallback-terminal' }
      }
      const tabId = createDefaultBrowserSurface(store, worktree.id)
      return tabId ? { kind: 'created', tabId } : { kind: 'fallback-terminal' }
    }
  }
}
