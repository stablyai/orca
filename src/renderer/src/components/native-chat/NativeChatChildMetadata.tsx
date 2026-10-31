import { useTranslation } from 'react-i18next'
import { translate } from '@/i18n/i18n'
import { selectExecutionHostDisplayLabel } from '@/lib/execution-host-display-label'
import { structuredAgentLabel } from '@/lib/structured-agent-session-launch-label'
import { useAppStore } from '@/store'
import { executionHostIdForStructuredTarget } from '@/runtime/structured-agent-session-owner'
import { isStructuredAgentId } from '../../../../shared/agent-session-provider-handle-encoding'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { OrchestrationSessionChild } from '../../../../shared/orchestration-session-children'
import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'

export function NativeChatChildMetadata({
  worker,
  target,
  detailed = false
}: {
  worker: OrchestrationSessionChild
  target?: RuntimeClientTarget
  detailed?: boolean
}): React.JSX.Element | null {
  useTranslation()
  const agent =
    worker.conversation.kind === 'journal' ? worker.conversation.agent : worker.metadata?.agent
  const agentLabel =
    isStructuredAgentId(agent) && agent !== 'unknown' ? structuredAgentLabel(agent) : null
  const host = worker.metadata?.executionHost
  const hostLabel = useAppStore((state) => {
    switch (host?.kind) {
      case 'local': {
        if (!target) {
          return translate(
            'components.native-chat.children.metadata.localHost',
            'Local execution host'
          )
        }
        const label = selectExecutionHostDisplayLabel(
          state,
          executionHostIdForStructuredTarget(target)
        )
        return target.kind === 'environment' && label === target.environmentId
          ? translate(
              'components.native-chat.children.metadata.environment',
              'Environment {{value0}}',
              {
                value0: target.environmentId
              }
            )
          : label
      }
      case 'wsl':
        if (typeof host.distro !== 'string' || !host.distro.trim()) {
          return null
        }
        return translate('components.native-chat.children.metadata.wsl', 'WSL · {{value0}}', {
          value0: host.distro
        })
      case 'ssh': {
        if (typeof host.targetId !== 'string' || !host.targetId.trim()) {
          return null
        }
        const label = target
          ? selectExecutionHostDisplayLabel(state, toSshExecutionHostId(host.targetId), {
              sshEnvironmentId: target.kind === 'environment' ? target.environmentId : null
            })
          : host.targetId
        return translate('components.native-chat.children.metadata.ssh', 'SSH · {{value0}}', {
          value0: label === host.targetId ? label : `${label} (${host.targetId})`
        })
      }
      case 'environment':
        if (typeof host.environmentId !== 'string' || !host.environmentId.trim()) {
          return null
        }
        return (
          (typeof host.label === 'string' && host.label.trim()) ||
          translate(
            'components.native-chat.children.metadata.environment',
            'Environment {{value0}}',
            {
              value0: host.environmentId
            }
          )
        )
      case undefined:
        return null
    }
  })
  if (!agentLabel && !hostLabel) {
    return null
  }
  if (!detailed) {
    return <>{[agentLabel, hostLabel].filter(Boolean).join(' · ')}</>
  }
  const unknown = translate('components.native-chat.children.metadata.unknown', 'Unknown')
  return (
    <dl className="flex shrink-0 flex-wrap gap-x-4 gap-y-1 px-4 pt-2 text-xs text-chat-foreground-faint">
      <div className="flex min-w-0 gap-1">
        <dt>{translate('components.native-chat.children.metadata.agent', 'Agent')}</dt>
        <dd className="min-w-0 break-words">{agentLabel ?? unknown}</dd>
      </div>
      <div className="flex min-w-0 gap-1">
        <dt className="shrink-0">
          {translate('components.native-chat.children.metadata.host', 'Execution host')}
        </dt>
        <dd className="min-w-0 break-words">{hostLabel ?? unknown}</dd>
      </div>
    </dl>
  )
}
