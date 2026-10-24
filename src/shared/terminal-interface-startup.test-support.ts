import type { RuntimeMobileSessionTabsSnapshot } from './runtime-types'
import type { TuiAgent } from './tui-agent'

export const terminalStartupBinding = {
  ptyId: 'startup-pty',
  incarnationId: 'startup-birth',
  terminalHandle: 'startup-handle',
  paneKey: 'tab:11111111-1111-4111-8111-111111111111'
}

/** Data at the renderer-to-host boundary, checked on both sides. */
export function terminalStartupSnapshot(
  agent: TuiAgent,
  draft: string | undefined,
  worktreeId: string,
  bound: boolean
): RuntimeMobileSessionTabsSnapshot {
  const leafId = '11111111-1111-4111-8111-111111111111'
  return {
    worktree: worktreeId,
    publicationEpoch: 'startup',
    snapshotVersion: 1,
    activeGroupId: null,
    activeTabId: null,
    activeTabType: 'terminal',
    tabs: [
      {
        type: 'terminal',
        id: `tab::${leafId}`,
        title: 'Agent',
        customTitle: null,
        parentTabId: 'tab',
        leafId,
        ptyId: bound ? terminalStartupBinding.ptyId : null,
        launchAgent: agent,
        ...(draft ? { launchDraft: draft, launchDraftCreatedAt: 1 } : {}),
        parentLayout: {
          root: { type: 'leaf', leafId },
          activeLeafId: leafId,
          expandedLeafId: null
        },
        isActive: true
      }
    ]
  }
}
