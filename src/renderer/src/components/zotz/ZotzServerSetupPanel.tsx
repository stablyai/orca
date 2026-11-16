import { Check, CircleDashed, ExternalLink, Minus, X } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import type {
  ZotzNodeSetupResult,
  ZotzNodeSetupStep
} from '../../../../shared/zotz/zotz-node-setup-contract'
import { useMountedRef } from '@/hooks/useMountedRef'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { cn } from '@/lib/class-names'
import { LoadingSpinner } from '../LoadingSpinner'
import { Button } from '../ui/button'
import { ZotzAccessLink } from './ZotzAccessLink'
import { zotzNodeSetupStepDetail, zotzNodeSetupStepTitle } from './zotz-node-setup-step-labels'

type SetupState = 'intro' | 'running' | 'finished'

export function ZotzServerSetupPanel({
  onBack,
  onStart,
  onDone
}: {
  onBack: () => void
  onStart: () => void
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const mountedRef = useMountedRef()
  const updateSettings = useAppStore((state) => state.updateSettings)
  const [state, setState] = useState<SetupState>('intro')
  const [steps, setSteps] = useState<ZotzNodeSetupStep[]>([])
  const [result, setResult] = useState<ZotzNodeSetupResult | null>(null)

  const start = async (): Promise<void> => {
    setState('running')
    setResult(null)
    onStart()
    // Server mode first: it keeps the node awake and exposed from the next launch even if a step fails.
    await updateSettings({ zotzMachineMode: 'server' })
    const unsubscribe = window.api.zotzNode.onSetupProgress((next) => {
      if (mountedRef.current) {
        setSteps(next)
      }
    })
    try {
      const outcome = await window.api.zotzNode.runServerSetup()
      if (mountedRef.current) {
        setSteps(outcome.steps)
        setResult(outcome)
      }
    } catch (error) {
      toast.error(error instanceof Error ? error.message : String(error))
    } finally {
      unsubscribe()
      if (mountedRef.current) {
        setState('finished')
      }
    }
  }

  const failed = steps.some((step) => step.status === 'failed')

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <h1 className="text-xl font-semibold">
          {t('zotz.nodeSetup.title', 'Set up this computer as a remote server')}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t(
            'zotz.nodeSetup.description',
            'Zotz connects Tailscale (installing it if missing), keeps this computer awake, opens its port only to your tailnet, starts at sign-in and restarts if it stops. Settings that need an administrator are applied with one permission prompt.'
          )}
        </p>
      </div>
      {steps.length > 0 ? (
        <ol className="space-y-1">
          {steps.map((step) => (
            <StepRow key={step.id} step={step} />
          ))}
        </ol>
      ) : null}
      {state === 'finished' && result?.tailscaleIp ? (
        <section className="space-y-3 rounded-xl border border-border bg-card/50 p-4">
          <h2 className="text-sm font-semibold">{t('zotz.nodeSetup.link.title', 'Access link')}</h2>
          <p className="text-xs text-muted-foreground">
            {t(
              'zotz.nodeSetup.link.description',
              'Anyone with the link can run commands as you on this computer until you revoke it in Settings.'
            )}
          </p>
          <ZotzAccessLink address={result.tailscaleIp} />
        </section>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        {state === 'intro' ? (
          <>
            <Button type="button" variant="ghost" onClick={onBack}>
              {t('zotz.machineMode.back', 'Back')}
            </Button>
            <Button type="button" onClick={() => void start()}>
              {t('zotz.nodeSetup.start', 'Set up server')}
            </Button>
          </>
        ) : null}
        {state === 'running' ? (
          <Button type="button" disabled>
            <LoadingSpinner className="size-4" />
            {t('zotz.nodeSetup.running', 'Setting up…')}
          </Button>
        ) : null}
        {state === 'finished' ? (
          <>
            {failed ? (
              <Button type="button" variant="secondary" onClick={() => void start()}>
                {t('zotz.nodeSetup.retry', 'Run again')}
              </Button>
            ) : null}
            <Button type="button" onClick={onDone}>
              {t('zotz.nodeSetup.done', 'Done')}
            </Button>
          </>
        ) : null}
      </div>
    </div>
  )
}

function StepIcon({ status }: { status: ZotzNodeSetupStep['status'] }): React.JSX.Element {
  switch (status) {
    case 'running':
      return <LoadingSpinner className="size-4" />
    case 'done':
      return <Check className="size-4" />
    case 'skipped':
      return <Minus className="size-4 text-muted-foreground" />
    case 'failed':
      return <X className="size-4 text-destructive" />
    case 'pending':
      return <CircleDashed className="size-4 text-muted-foreground" />
  }
}

function StepRow({ step }: { step: ZotzNodeSetupStep }): React.JSX.Element {
  const t = useTranslate()
  const detail = zotzNodeSetupStepDetail(step, t)
  const url = step.url
  return (
    <li className="flex items-start gap-3 rounded-md px-2 py-2">
      <span className="mt-0.5 shrink-0">
        <StepIcon status={step.status} />
      </span>
      <div className="min-w-0 flex-1 space-y-0.5">
        <p className={cn('text-sm', step.status === 'pending' && 'text-muted-foreground')}>
          {zotzNodeSetupStepTitle(step.id, t)}
        </p>
        {detail ? (
          <p
            className={cn(
              'text-xs break-words',
              step.status === 'failed' ? 'text-destructive' : 'text-muted-foreground'
            )}
          >
            {detail}
          </p>
        ) : null}
      </div>
      {url ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0"
          onClick={() => void window.api.shell.openUrl(url)}
        >
          <ExternalLink />
          {t('zotz.nodeSetup.open', 'Open')}
        </Button>
      ) : null}
    </li>
  )
}
