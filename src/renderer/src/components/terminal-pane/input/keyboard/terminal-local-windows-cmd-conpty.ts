import { useAppStore } from '@/store/index'
import { makePaneKey } from '../../../../../../shared/workspace-layout/stable-pane-id'
import { resolveHostAgentStartupShell } from '../../../../../../shared/windows-terminal-shell'
import { paneHasKnownAgentIdentity } from '../../pty-connection/agent-identity/pane-known-agent-identity'
import type { PtyTransport } from '../../pty-transport/pty-transport-types'

// Why: cmd titles itself with its own path at the prompt and appends " - <command>" while a child runs.
const CMD_IDLE_TITLE = /(?:^|[\\/\s])cmd\.exe$/i

function isCmdIdleTitle(title: string | null | undefined): boolean {
  return CMD_IDLE_TITLE.test(title?.trim() ?? '')
}

/** A local ConPTY cmd prompt with no agent: cooked cmd erases a word on BS but echoes Ctrl+W as ^W (#40325). */
export function isLocalWindowsCmdPrompt(args: {
  tabShellOverride: string | null | undefined
  hostTerminalWindowsShell: string | null | undefined
  paneTitle: string | null | undefined
  paneHasAgent: () => boolean
  isLocalWindowsConpty: () => boolean
}): boolean {
  return (
    resolveHostAgentStartupShell({
      platform: 'win32',
      isRemote: false,
      tabShellOverride: args.tabShellOverride,
      hostTerminalWindowsShell: args.hostTerminalWindowsShell
    }) === 'cmd' &&
    // Why: bash, Python or ssh started from cmd read BS as a one-char delete; unknown titles keep Ctrl+W.
    isCmdIdleTitle(args.paneTitle) &&
    // Why: raw-mode TUIs like Claude Code read BS as a one-char delete and need Ctrl+W.
    !args.paneHasAgent() &&
    args.isLocalWindowsConpty()
  )
}

/** Read only in-memory pane state; Ctrl+Backspace must not wait on a process read. */
export function readLocalWindowsCmdPromptPane(args: {
  isWindows: boolean
  tabId: string
  pane: { id: number; leafId: string } | undefined
  transport: Pick<PtyTransport, 'getLocalSessionMetadata'> | undefined
  isLocalWindowsConpty: () => boolean
}): boolean {
  // Why: null metadata means SSH or no local session, neither of which is a local ConPTY cmd.
  const sessionMetadata = args.isWindows ? args.transport?.getLocalSessionMetadata?.() : null
  const pane = args.pane
  if (!pane || !sessionMetadata) {
    return false
  }
  const state = useAppStore.getState()
  return isLocalWindowsCmdPrompt({
    tabShellOverride: sessionMetadata.shellOverride,
    hostTerminalWindowsShell: state.settings?.terminalWindowsShell,
    paneTitle: state.runtimePaneTitlesByTabId[args.tabId]?.[pane.id],
    paneHasAgent: () => paneHasKnownAgentIdentity(state, makePaneKey(args.tabId, pane.leafId)),
    isLocalWindowsConpty: args.isLocalWindowsConpty
  })
}
