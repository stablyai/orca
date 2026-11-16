import { AlertTriangle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { useNow } from '@/hooks/use-now'
import type { AgentSessionHeldDelivery } from '../../../../../shared/agent-session/agent-session-held-delivery'
import { formatAgentTypeLabel } from '../../../../../shared/agent-status/presentation/agent-type-label'
import { formatUsageLimitResetClock } from '../../../../../shared/agent-session/failures/agent-session-usage-limit'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { useWorkerSignInRecovery } from './use-worker-sign-in-recovery'

export function NativeChatWorkerFailureStatus({
  delivery,
  workerName,
  pending,
  onResume,
  onSignIn,
  onOpenWorker,
  target,
  signInResolved: resolved
}: {
  delivery: AgentSessionHeldDelivery
  workerName: string
  pending: boolean
  onResume: () => void
  onSignIn: () => void
  onOpenWorker?: () => void
  target?: RuntimeClientTarget
  signInResolved?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const failure = delivery.reason.failure
  const observedSignIn = useWorkerSignInRecovery(delivery, target)
  const signInResolved = resolved || observedSignIn
  const now = useNow(60_000, failure === 'usage-limit' && !!delivery.resetsAt)
  const provider = formatAgentTypeLabel(delivery.provider)
  const labels = {
    network: t('components.native-chat.workerFailure.network', 'network error'),
    provider: t('components.native-chat.workerFailure.provider', '{{provider}} error', {
      provider
    }),
    'sign-in': t('components.native-chat.workerFailure.signIn', 'signed out'),
    'usage-limit': t('components.native-chat.workerFailure.usage', 'usage limit'),
    unknown: t('components.native-chat.workerFailure.unknown', 'unknown error')
  }
  const heading =
    failure === 'sign-in' && signInResolved
      ? t('components.native-chat.workerFailure.stoppedWithoutCause', '{{worker}} stopped', {
          worker: workerName
        })
      : delivery.recoveryUsed
        ? t('components.native-chat.workerFailure.again', '{{worker}} failed again: {{cause}}', {
            worker: workerName,
            cause: labels[failure]
          })
        : t('components.native-chat.workerFailure.stopped', '{{worker}} stopped: {{cause}}', {
            worker: workerName,
            cause: labels[failure]
          })
  const reset =
    failure === 'usage-limit' && delivery.resetsAt && now < delivery.resetsAt
      ? t('components.native-chat.workerFailure.reset', 'resets {{time}}', {
          time: formatUsageLimitResetClock(delivery.resetsAt)
        })
      : null
  const count =
    delivery.waiting === 0
      ? null
      : delivery.waiting === 1
        ? t('components.native-chat.workerFailure.oneWaiting', '1 message waiting')
        : t('components.native-chat.workerFailure.manyWaiting', '{{count}} messages waiting', {
            count: delivery.waiting
          })
  const resumeAvailable =
    delivery.waiting > 0 &&
    (failure !== 'usage-limit' || (!!delivery.resetsAt && now >= delivery.resetsAt))
  return (
    <div role="status" className="flex items-center gap-2 py-1 text-xs text-chat-warning">
      <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0" />
      <p className="min-w-0 flex-1">{[heading, reset, count].filter(Boolean).join(' · ')}</p>
      {onOpenWorker ? (
        <Button type="button" variant="ghost" size="xs" onClick={onOpenWorker}>
          {t('components.native-chat.workerFailure.openWorker', 'Open worker')}
        </Button>
      ) : failure === 'sign-in' && !signInResolved ? (
        <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={onSignIn}>
          {t('components.native-chat.workerFailure.signInAction', 'Sign in')}
        </Button>
      ) : resumeAvailable && failure !== 'sign-in' ? (
        <Button type="button" variant="ghost" size="xs" disabled={pending} onClick={onResume}>
          {t('components.native-chat.queuedMessages.resume', 'Resume')}
        </Button>
      ) : null}
    </div>
  )
}
