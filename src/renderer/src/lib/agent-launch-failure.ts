import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import { getAgentLabel } from '@/lib/agent-catalog'
import type { TuiAgent } from '../../../shared/tui-agent'
import type { ExecutionHostPlatformFact } from './execution-host-facts'

type Recovery = Extract<ExecutionHostPlatformFact, { kind: 'withheld' }>['recovery']

export function agentLaunchRecoveryMessage(recovery: Recovery): string {
  switch (recovery) {
    case 'connectSsh':
      return translate(
        'agentLaunch.connectSsh',
        'Connect to this workspace’s SSH host, then try again.'
      )
    case 'sshUnavailable':
      return translate(
        'agentLaunch.sshUnavailable',
        'Terminal launch is unavailable on this SSH host. Open a terminal in the workspace and start the agent there.'
      )
    case 'reconnectServer':
      return translate(
        'agentLaunch.reconnectServer',
        'Reconnect to this workspace’s Orca server, then try again.'
      )
    case 'updateServer':
      return translate(
        'agentLaunch.updateServer',
        'Update Orca on this workspace’s server, then try again.'
      )
    case 'refreshProjects':
      return translate(
        'auto.store.slices.workspace.cleanup.hostUnresolved',
        'Orca cannot tell which host owns this workspace. Refresh projects and review it again.'
      )
  }
}

export function agentLaunchCheckSettingsMessage(): string {
  return translate(
    'agentLaunch.checkSettings',
    'Check the agent’s launch settings, then try again.'
  )
}

export function notifyAgentLaunchFailure(agent: TuiAgent, description?: string): void {
  toast.error(
    translate(
      'components.agentSessionContinuation.launchFailed',
      'Could not start a new {{agent}} session.',
      { agent: getAgentLabel(agent) }
    ),
    { description: description ?? agentLaunchCheckSettingsMessage() }
  )
}
