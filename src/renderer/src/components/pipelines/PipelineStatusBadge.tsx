import { CheckCircle2, Circle, CircleAlert, CirclePause, LoaderCircle } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { useTranslate } from '@/i18n/use-translate'
import { pipelineRunStateLabel } from './pipeline-run-labels'

export function pipelineStatusTone(
  state: string
): 'statusSuccess' | 'statusWarning' | 'statusRunning' | 'statusError' | 'secondary' {
  if (state === 'completed') {
    return 'statusSuccess'
  }
  if (
    ['waiting_owner', 'reconciliation_required', 'blocked', 'interrupted', 'rework'].includes(state)
  ) {
    return 'statusWarning'
  }
  if (state === 'failed') {
    return 'statusError'
  }
  if (state === 'running') {
    return 'statusRunning'
  }
  return 'secondary'
}

export function PipelineStatusBadge({ state, label }: { state: string; label?: string }) {
  const t = useTranslate()
  const Icon =
    state === 'completed'
      ? CheckCircle2
      : state === 'running'
        ? LoaderCircle
        : state === 'paused'
          ? CirclePause
          : [
                'waiting_owner',
                'reconciliation_required',
                'blocked',
                'interrupted',
                'failed',
                'rework'
              ].includes(state)
            ? CircleAlert
            : Circle
  return (
    <Badge variant={pipelineStatusTone(state)} className="max-w-full whitespace-normal text-left">
      <Icon className="shrink-0" />
      <span className="min-w-0 break-words">{label ?? pipelineRunStateLabel(state, t)}</span>
    </Badge>
  )
}
