import { translate } from '@/i18n/i18n'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'

export function nativeChatMcpHandoffNotice({
  structured,
  remote,
  open,
  pending
}: {
  structured: boolean
  remote: boolean
  open?: () => void
  pending: boolean
}): NativeChatComposerNotice {
  const instructions = structured
    ? translate(
        'components.native-chat.mcp.structuredHandoff',
        'Open a terminal copy of this conversation, run /mcp, and choose a server to authenticate. Continue in that terminal after signing in. Your original chat and draft stay here.'
      )
    : translate(
        'components.native-chat.mcp.terminalHandoff',
        'Open this session’s terminal, run /mcp, and choose a server to authenticate. Return to Chat when finished; your draft stays here.'
      )
  const unavailable = translate(
    'components.native-chat.mcp.unavailable',
    'The terminal is unavailable here. Open this conversation in Claude on its execution host and run /mcp to sign in.'
  )
  const host = remote
    ? translate(
        'components.native-chat.mcp.remoteBrowser',
        'Use a browser on the computer running Claude so the sign-in callback reaches that computer.'
      )
    : ''
  return {
    key: 'claude-mcp-handoff',
    kind: 'command',
    text: [
      translate(
        'components.native-chat.mcp.interactiveSignIn',
        'Sign in to MCP servers through Claude’s terminal.'
      ),
      open ? instructions : unavailable,
      host
    ]
      .filter(Boolean)
      .join(' '),
    ...(open
      ? {
          action: {
            label: pending
              ? translate('components.native-chat.mcp.preparing', 'Preparing terminal…')
              : structured
                ? translate('components.native-chat.mcp.openCopy', 'Open terminal copy')
                : translate('components.native-chat.mcp.openTerminal', 'Open terminal'),
            onClick: open,
            disabled: pending
          }
        }
      : {})
  }
}
