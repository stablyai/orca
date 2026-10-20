import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { useRepositoryAddScriptPromptStore } from '@/store/repository-add-script-prompt'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'

export function RepositoryAddScriptPromptDialog(): React.JSX.Element {
  const current = useRepositoryAddScriptPromptStore((state) => state.current)
  const takePrompt = useRepositoryAddScriptPromptStore(
    (state) => state.takeRepositoryAddScriptPrompt
  )

  // Why: every dismissal path (Esc, overlay, close button) is a skip; only Run may execute.
  const handleOpenChange = (open: boolean): void => {
    if (!open) {
      takePrompt('skip')
    }
  }

  const preview = current?.preview
  // A filesystem root has no basename; show the path itself rather than an empty title.
  const repoName = preview ? basename(preview.path) || preview.path : ''

  return (
    <Dialog open={current !== null} onOpenChange={handleOpenChange}>
      <DialogContent surface="security" className="sm:max-w-xl">
        {preview ? (
          <>
            <DialogHeader>
              <DialogTitle size="compact">
                {translate(
                  'auto.components.sidebar.RepositoryAddScriptPromptDialog.title',
                  'Run add script for {{repo}}?',
                  { repo: repoName }
                )}
              </DialogTitle>
              <DialogDescription size="compact">
                {translate(
                  'auto.components.sidebar.RepositoryAddScriptPromptDialog.description',
                  'This script was configured for {{host}}. It runs the first time a repository is added to Orca, and you can run or skip it each time.',
                  { host: preview.hostLabel }
                )}
              </DialogDescription>
            </DialogHeader>

            <div className="rounded-md border border-border/70 bg-muted/35 px-3 py-2">
              <div className="mb-1 text-3xs font-medium uppercase tracking-wide text-muted-foreground">
                {translate(
                  'auto.components.sidebar.RepositoryAddScriptPromptDialog.scriptLabel',
                  'Add script'
                )}
              </div>
              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-xs text-foreground scrollbar-sleek">
                {preview.script}
              </pre>
            </div>

            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.RepositoryAddScriptPromptDialog.target',
                'Runs in {{cwd}} on {{host}}',
                { cwd: preview.target.cwd, host: preview.hostLabel }
              )}
            </p>

            <DialogFooter>
              <Button variant="outline" onClick={() => takePrompt('skip')}>
                {translate('auto.components.sidebar.RepositoryAddScriptPromptDialog.skip', 'Skip')}
              </Button>
              <Button onClick={() => takePrompt('run')}>
                {translate('auto.components.sidebar.RepositoryAddScriptPromptDialog.run', 'Run')}
              </Button>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  )
}
