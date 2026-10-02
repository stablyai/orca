import { showAgentLaunchNotStartedNotice } from '@/lib/agent-launch-prompt-not-delivered-notice'

/** Tabs whose refused agent launch the user was already told about. */
const noticedTabIds = new Set<string>()

/**
 * The host refused to start a pane's agent (`launch_file_unavailable`), so nothing ran in it. The
 * notice holds the prompt, once per tab: the empty pane's recovery spawns it again, and is refused
 * again. A tab left with no live terminal is closed, as main's desktop route closes a refused tab;
 * one that still holds a live terminal is the user's, and stays.
 */
export function settleRefusedAgentLaunch(args: {
  tabId: string | undefined
  prompt: string
}): void {
  const { tabId } = args
  if (tabId !== undefined && noticedTabIds.has(tabId)) {
    return
  }
  if (tabId !== undefined) {
    noticedTabIds.add(tabId)
  }
  showAgentLaunchNotStartedNotice({ prompt: args.prompt })
  if (tabId !== undefined) {
    void closeTabLeftEmpty(tabId).catch((error: unknown) =>
      console.error('Could not close a refused tab', error)
    )
  }
}

async function closeTabLeftEmpty(tabId: string): Promise<void> {
  // Why lazy: the store's terminal slice imports this transport, so a static import is a cycle.
  const [{ useAppStore }, { closeTerminalTab }] = await Promise.all([
    import('@/store'),
    import('@/components/terminal/terminal-tab-actions')
  ])
  if ((useAppStore.getState().ptyIdsByTabId[tabId] ?? []).length === 0) {
    closeTerminalTab(tabId, {
      force: true,
      skipRunningProcessConfirm: true,
      captureRecentlyClosed: false
    })
  }
}
