import { useState } from 'react'
import { Loader2, TriangleAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { getTauriRuntimeInitFailure, initializeTauriRuntime } from './tauri-runtime-startup'

// Shown instead of the App when the owned Tauri runtime failed to start, so no
// client is created against the previous launch's stale endpoint.
export default function TauriRuntimeInitFailure({
  onRecovered
}: {
  onRecovered: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [failure, setFailure] = useState<unknown>(() => getTauriRuntimeInitFailure())
  const [retrying, setRetrying] = useState(false)

  const detail = failure instanceof Error ? failure.message : String(failure)

  const retry = async (): Promise<void> => {
    if (retrying) {
      return
    }
    setRetrying(true)
    try {
      await initializeTauriRuntime()
    } catch (error) {
      setFailure(error)
      setRetrying(false)
      return
    }
    setRetrying(false)
    onRecovered()
  }

  return (
    <div className="flex min-h-dvh items-center justify-center bg-background p-6">
      <div className="w-full max-w-md rounded-lg border bg-card p-6 text-card-foreground shadow-sm">
        <div className="flex items-center gap-2">
          <TriangleAlert className="size-5 text-destructive" />
          <h1 className="text-base font-semibold">
            {t('tauri.runtimeInit.title', 'Local runtime failed to start')}
          </h1>
        </div>
        <p className="mt-2 text-sm text-muted-foreground">
          {t(
            'tauri.runtimeInit.description',
            'Orca could not start its local runtime, so the previous connection was not reused. Retry to start it again.'
          )}
        </p>
        <pre className="scrollbar-sleek mt-3 max-h-32 overflow-auto rounded-md bg-muted p-3 text-xs text-muted-foreground">
          {detail}
        </pre>
        <p className="mt-3 text-xs text-muted-foreground">
          {t(
            'tauri.runtimeInit.hint',
            'If this keeps failing, the runtime log (orcad-supervisor-stderr.log) has the crash details.'
          )}
        </p>
        <Button className="mt-4 w-full" disabled={retrying} onClick={() => void retry()}>
          {retrying && <Loader2 className="size-4 animate-spin" />}
          {t('tauri.runtimeInit.retry', 'Retry')}
        </Button>
      </div>
    </div>
  )
}
