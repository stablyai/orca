import { RefreshCw } from 'lucide-react'
import type { BundledSkillUnsupportedReason } from '@/runtime/runtime-bundled-skills-client'
import { Button } from '../ui/button'
import { skillInstallResultLine } from './bundled-skill-setup-result-copy'
import {
  bundledSkillInstallNeedsAttention,
  type BundledSkillInstall
} from '@/hooks/use-bundled-skill-install'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

export function BundledSkillInstallStatus(props: {
  install: Pick<BundledSkillInstall, 'state' | 'retry'>
  buttonSize?: 'xs' | 'sm'
  className?: string
  attention?: { retry: () => void; message?: string }
  unsupported?: BundledSkillUnsupportedReason
}): React.JSX.Element | null {
  const previewAttention =
    props.attention && (props.install.state.kind === 'idle' || props.install.state.kind === 'done')
  const state = props.unsupported
    ? { kind: 'unsupported' as const, reason: props.unsupported }
    : previewAttention
      ? {
          kind: 'failed' as const,
          message:
            props.attention?.message ??
            translate('auto.components.skills.skillPlanOpCopy.needsAttention', 'Needs attention')
        }
      : props.install.state
  const retry = previewAttention ? props.attention?.retry : props.install.retry
  if (state.kind === 'idle' || state.kind === 'installing') {
    return null
  }
  if (state.kind === 'unsupported') {
    return (
      <p className={cn('text-xs leading-snug text-muted-foreground', props.className)}>
        {state.reason === 'connect-host'
          ? translate(
              'auto.components.settings.BundledSkillInstallStatus.connectHost',
              'Connect to this SSH host to install its skills.'
            )
          : translate(
              'auto.components.settings.BundledSkillInstallStatus.updateServer',
              'Update Orca on the server to install its skills.'
            )}
      </p>
    )
  }
  const problem = bundledSkillInstallNeedsAttention(state)
  const message =
    state.kind === 'failed' ? state.message : skillInstallResultLine(state.result, state.changes)
  return (
    <div className={cn('flex flex-wrap items-baseline gap-2', props.className)}>
      <p
        className={cn(
          'min-w-0 flex-1 whitespace-pre-line text-xs leading-snug',
          problem ? 'text-destructive' : 'text-muted-foreground'
        )}
      >
        {message}
      </p>
      {problem ? (
        <Button type="button" variant="ghost" size={props.buttonSize ?? 'sm'} onClick={retry}>
          <RefreshCw className="size-3.5" />
          {translate('auto.components.settings.AgentSkillSetupPanel.retrySetup', 'Retry')}
        </Button>
      ) : null}
    </div>
  )
}
