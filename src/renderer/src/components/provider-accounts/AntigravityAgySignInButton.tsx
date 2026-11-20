import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { useNativeChatHostCommandTerminal } from '@/components/native-chat/host-access/native-chat-host-command-terminal'
import {
  agentSessionSignInCommand,
  agentSessionSignInEnv
} from '../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { resolveHostAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { Button } from '../ui/button'

/** The chat's own Sign in for agy: runs `agy` in a terminal of the open workspace on this
 *  computer, where agy's login then serves Antigravity chats. Absent without a workspace. */
export function AntigravityAgySignInButton(): React.JSX.Element | null {
  const t = useTranslate()
  const worktreeId = useAppStore((s) => s.activeWorktreeId)
  const terminalWindowsShell = useAppStore((s) => s.settings?.terminalWindowsShell)
  const terminal = useNativeChatHostCommandTerminal({ target: { kind: 'local' }, worktreeId })
  const platform = getRendererAppPlatform()
  const shell =
    resolveHostAgentStartupShell({
      platform,
      isRemote: false,
      hostTerminalWindowsShell: terminalWindowsShell
    }) ?? (platform === 'win32' ? null : 'posix')
  const command = agentSessionSignInCommand('antigravity', {
    account: 'system',
    remote: false,
    shell
  })
  if (!terminal || !command) {
    return null
  }
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={terminal.opening}
      title={t(
        'components.native-chat.signInNotice.runsCommand',
        'Runs {{command}} in a terminal',
        {
          command
        }
      )}
      onClick={() =>
        void terminal.open(command, agentSessionSignInEnv('antigravity')).then((opened) => {
          // The terminal is in the workspace behind Settings, where the login happens.
          if (opened) {
            useAppStore.getState().closeSettingsPage?.()
          }
        })
      }
    >
      {t('components.native-chat.signInNotice.signIn', 'Sign in')}
    </Button>
  )
}
