import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import {
  useRepositoryAddScriptResultStore,
  type RepositoryAddScriptResultView
} from '@/store/repository-add-script-result'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

function resultDescription(result: RepositoryAddScriptResultView): string {
  // A filesystem root has no basename; show the path itself rather than an empty name.
  const values = { repo: basename(result.path) || result.path, host: result.hostLabel }
  if (result.status === 'unverifiable') {
    return translate(
      'auto.components.sidebar.RepositoryAddScriptResultDialog.unverifiableDescription',
      'Orca stopped the add script for {{repo}} on {{host}}, but could not confirm that it stopped. It may still be running.',
      values
    )
  }
  if (result.reason === 'execution-failed') {
    return translate(
      'auto.components.sidebar.RepositoryAddScriptResultDialog.executionFailedDescription',
      'Orca could not start the add script for {{repo}} on {{host}}.',
      values
    )
  }
  return translate(
    'auto.components.sidebar.RepositoryAddScriptResultDialog.failedDescription',
    'The add script for {{repo}} on {{host}} did not finish successfully.',
    values
  )
}

export function RepositoryAddScriptResultDialog(): React.JSX.Element {
  const result = useRepositoryAddScriptResultStore((state) => state.result)
  const dismiss = useRepositoryAddScriptResultStore(
    (state) => state.dismissRepositoryAddScriptResult
  )

  return (
    <Dialog
      open={result !== null}
      onOpenChange={(open) => {
        if (!open) {
          dismiss()
        }
      }}
    >
      <DialogContent surface="security" className="sm:max-w-xl">
        {result ? (
          <>
            <DialogHeader>
              <DialogTitle size="compact">
                {result.status === 'unverifiable'
                  ? translate(
                      'auto.components.sidebar.RepositoryAddScriptResultDialog.unverifiableTitle',
                      'Add script may still be running'
                    )
                  : translate(
                      'auto.components.sidebar.RepositoryAddScriptResultDialog.failedTitle',
                      'Add script failed'
                    )}
              </DialogTitle>
              <DialogDescription size="compact">{resultDescription(result)}</DialogDescription>
            </DialogHeader>

            {result.status === 'failed' && result.reason !== 'execution-failed' ? (
              <p className="text-xs text-muted-foreground">
                {result.exitCode === undefined
                  ? translate(
                      'auto.components.sidebar.RepositoryAddScriptResultDialog.noExitCode',
                      'No exit code was recorded.'
                    )
                  : translate(
                      'auto.components.sidebar.RepositoryAddScriptResultDialog.exitCode',
                      'Exit code {{code}}',
                      { code: result.exitCode }
                    )}
              </p>
            ) : null}

            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
              <div className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                {translate(
                  'auto.components.sidebar.RepositoryAddScriptResultDialog.output',
                  'Output'
                )}
              </div>
              {result.output ? (
                <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground scrollbar-sleek">
                  {result.output}
                </pre>
              ) : (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'auto.components.sidebar.RepositoryAddScriptResultDialog.noOutput',
                    'No output was recorded.'
                  )}
                </p>
              )}
            </div>

            {result.outputTruncated ? (
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.sidebar.RepositoryAddScriptResultDialog.truncated',
                  'Output was truncated; earlier lines are not shown.'
                )}
              </p>
            ) : null}

            <DialogFooter>
              <Button variant="outline" onClick={dismiss}>
                {translate(
                  'auto.components.sidebar.RepositoryAddScriptResultDialog.close',
                  'Close'
                )}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
