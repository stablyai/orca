import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
import type { ExternalAutomationRun } from '../../../../shared/automations-types'
import type { SelectedExternalRunPage } from './automation-page-state'
import { externalAutomationRunKey } from './external-automation-scope-keys'
import { getExternalRunContent } from './external-automation-display'
import { HermesCronOutputView } from './HermesCronOutputView'

export function ExternalAutomationRunOutput({ selected }: { selected: SelectedExternalRunPage }) {
  return selected.run.outputContentDeferred ? (
    <DeferredRunOutput
      key={externalAutomationRunKey(selected.scope, selected.job.id, selected.run.id)}
      selected={selected}
    />
  ) : (
    <HermesCronOutputView content={getExternalRunContent(selected.run)} />
  )
}

function DeferredRunOutput({ selected }: { selected: SelectedExternalRunPage }) {
  const [result, setResult] = useState<ExternalAutomationRun | Error | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [showLoading, setShowLoading] = useState(false)
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => setShowLoading(true), 200)
    void window.api.automations
      .listExternalRunsForOwner({
        ...selected.scope,
        jobId: selected.job.id,
        runId: selected.run.id,
        page: 1,
        pageSize: 1
      })
      .then((page) => {
        if (cancelled) {
          return
        }
        const run = page.runs.find((candidate) => candidate.id === selected.run.id)
        setResult(run && !run.outputContentDeferred ? run : new Error('Run output is unavailable.'))
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setResult(error instanceof Error ? error : new Error(String(error)))
        }
      })
      .finally(() => clearTimeout(timer))
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [selected, attempt])

  if (result instanceof Error) {
    return (
      <div className="space-y-2 p-4 text-sm">
        <p role="alert" className="text-destructive">
          {result.message}
        </p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setResult(null)
            setShowLoading(false)
            setAttempt((value) => value + 1)
          }}
        >
          {translate('common.retry', 'Retry')}
        </Button>
      </div>
    )
  }
  if (result) {
    return <HermesCronOutputView content={getExternalRunContent(result)} />
  }
  return showLoading ? (
    <div role="status" className="flex items-center gap-2 p-4 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {translate('automations.runOutput.loading', 'Loading run output...')}
    </div>
  ) : null
}
