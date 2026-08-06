import { useAppStore } from '@/store'
import { makePaneKey, type PaneKey } from '../../../shared/stable-pane-id'
import type { AgentType } from '../../../shared/agent-status-types'
import { bindAutomationTerminal } from '@/lib/automation-terminal-ownership'
import { createBrowserUuid } from '@/lib/browser-uuid'
import { retireProvider, retireUnownedTerminal } from '@/lib/retire-unowned-background-terminal'
import { isTerminalTabPresent } from '@/store/slices/terminal-tab-retirement'
import type { RuntimeClientTarget } from '@/runtime/runtime-rpc-client'

type Store = ReturnType<typeof useAppStore.getState>
type RegisterArgs = Parameters<Store['registerAgentLaunchConfig']>

/** Reserves env-stable tab and pane identities before spawning the PTY. */
export function reserveAgentBackgroundSessionIdentity(args: {
  store: Store
  agentType: AgentType
  worktreeId: string
  launchConfig: RegisterArgs[1]
  env: Record<string, string> | undefined
}): {
  reservedTabId: string
  leafId: string
  paneKey: PaneKey
  launchToken: string
  launchRegistration: NonNullable<RegisterArgs[2]>
  paneEnv: Record<string, string>
} {
  const reservedTabId = createBrowserUuid()
  const leafId = createBrowserUuid()
  const paneKey = makePaneKey(reservedTabId, leafId)
  const launchToken = createBrowserUuid()
  const launchRegistration = {
    agentType: args.agentType,
    launchToken,
    tabId: reservedTabId,
    leafId
  }
  args.store.registerAgentLaunchConfig(paneKey, args.launchConfig, launchRegistration)
  return {
    reservedTabId,
    leafId,
    paneKey,
    launchToken,
    launchRegistration,
    paneEnv: {
      ...args.env,
      ORCA_PANE_KEY: paneKey,
      ORCA_TAB_ID: reservedTabId,
      ORCA_WORKTREE_ID: args.worktreeId,
      ORCA_AGENT_LAUNCH_TOKEN: launchToken
    }
  }
}

/** Publishes a hidden run tab already bound to its live PTY (#2989). */
export async function adoptAgentBackgroundSessionTab(args: {
  store: Store
  worktreeId: string
  reservedTabId: string
  ptyId: string
  paneKey: PaneKey
  launchConfig: RegisterArgs[1]
  launchRegistration: NonNullable<RegisterArgs[2]>
  runtimeTarget: RuntimeClientTarget
  runtimeTerminalHandle: string | null
  onRetire: () => void
  title?: string
}): Promise<{
  tab: ReturnType<Store['createTab']>
  paneKey: PaneKey
  terminalOwnership: ReturnType<typeof bindAutomationTerminal>
} | null> {
  const { store, reservedTabId, ptyId, launchRegistration } = args
  // The worktree can disappear while its PTY spawn is pending.
  if (
    await retireUnownedTerminal({
      owner: { worktreeId: args.worktreeId },
      ptyId,
      runtimeTarget: args.runtimeTarget,
      runtimeTerminalHandle: args.runtimeTerminalHandle,
      onRetire: args.onRetire
    })
  ) {
    return null
  }
  // Re-keying would desynchronize env-baked routing identities; fail closed.
  if (isTerminalTabPresent(useAppStore.getState(), reservedTabId)) {
    store.clearAgentLaunchConfig(args.paneKey)
    args.onRetire()
    await retireProvider({
      ptyId,
      runtimeTarget: args.runtimeTarget,
      runtimeTerminalHandle: args.runtimeTerminalHandle
    })
    return null
  }
  const tab = store.createTab(args.worktreeId, undefined, undefined, {
    id: reservedTabId,
    initialPtyId: ptyId,
    activate: false,
    recordInteraction: false
  })
  const paneKey = args.paneKey
  store.registerAgentLaunchConfig(paneKey, args.launchConfig, launchRegistration)
  const terminalOwnership = bindAutomationTerminal(
    tab,
    paneKey,
    ptyId,
    args.runtimeTarget.kind,
    args.title
  )
  return { tab, paneKey, terminalOwnership }
}
