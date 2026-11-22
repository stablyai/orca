import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { useWorktreeRuntimeTarget } from '@/runtime/rpc/targets/use-worktree-runtime-target'
import { useNativeChatHostCommandTerminal } from '@/components/native-chat/host-access/native-chat-host-command-terminal'
import {
  agentSessionSignInCommand,
  agentSessionSignInEnv
} from '../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { RuntimeClientTarget } from '../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveHostAgentStartupShell } from '../../../../shared/shell/launch/windows-terminal-shell'
import { Button } from '../ui/button'

function sameHost(a: RuntimeClientTarget | null, b: RuntimeClientTarget): boolean {
  if (a?.kind === 'environment') {
    return b.kind === 'environment' && a.environmentId === b.environmentId
  }
  return a?.kind === b.kind
}

/** The chat's own Sign in for agy: runs `agy` in a terminal of the open workspace when that
 *  workspace is on the host Settings shows. Absent otherwise; the description says what to run. */
export function AntigravityAgySignInButton({
  owner
}: {
  owner: RuntimeClientTarget
}): React.JSX.Element | null {
  const t = useTranslate()
  const worktreeId = useAppStore((s) => s.activeWorktreeId)
  const onOwner = sameHost(useWorktreeRuntimeTarget(worktreeId), owner)
  const terminal = useNativeChatHostCommandTerminal({
    target: owner,
    worktreeId: onOwner ? worktreeId : null
  })
  const shell = useAppStoreWithHostStatuses((s, statuses) => {
    const status =
      owner.kind === 'environment'
        ? lastVerifiedRuntimeStatus(statuses.get(owner.environmentId))
        : null
    const platform = owner.kind === 'local' ? getRendererAppPlatform() : status?.hostPlatform
    if (!platform) {
      return null
    }
    return (
      resolveHostAgentStartupShell({
        platform,
        isRemote: owner.kind !== 'local',
        hostTerminalWindowsShell:
          owner.kind === 'local' ? s.settings?.terminalWindowsShell : status?.terminalWindowsShell
      }) ?? (platform === 'win32' ? null : 'posix')
    )
  })
  const command = agentSessionSignInCommand('antigravity', {
    account: 'system',
    remote: owner.kind !== 'local',
    shell
  })
  if (!onOwner || !terminal || !command) {
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
