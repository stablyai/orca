import { Copy, Loader2 } from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { translate } from '@/i18n/i18n'
import { basename } from '@/lib/path'
import { notebookVenvParent } from '../../../../shared/notebook-venv-location'
import { cancelSetup, createVirtualEnvironment, installIpykernel } from './ipynb-kernel-session'
import { ipykernelInstallCommand, venvSetupCommand } from './ipynb-kernel-setup-commands'
import type { KernelSetup } from './ipynb-kernel-store'

type SetupMode = 'install' | 'venv' | 'installing' | 'creating-venv'

function setupCopy(mode: SetupMode, env: string, folder: string) {
  switch (mode) {
    case 'install':
      return {
        title: translate(
          'auto.components.editor.IpynbViewer.missingIpykernelTitle',
          'Install ipykernel?'
        ),
        description: translate(
          'auto.components.editor.IpynbViewer.missingIpykernel',
          "Running cells with '{{env}}' requires the ipykernel package.",
          { env }
        ),
        action: translate('auto.components.editor.IpynbViewer.install', 'Install')
      }
    case 'venv':
      return {
        title: translate(
          'auto.components.editor.IpynbViewer.createVenvTitle',
          'Create a virtual environment?'
        ),
        description: translate(
          'auto.components.editor.IpynbViewer.venvDescription',
          "Orca will create a .venv in {{folder}} from '{{env}}', install ipykernel into it, and run this notebook there.",
          { env, folder }
        ),
        action: translate('auto.components.editor.IpynbViewer.createVenv', 'Create .venv')
      }
    case 'installing':
      return {
        title: translate(
          'auto.components.editor.IpynbViewer.installingTitle',
          'Installing ipykernel…'
        ),
        description: translate(
          'auto.components.editor.IpynbViewer.installingDescription',
          "Installing ipykernel into '{{env}}' with pip. This can take a minute.",
          { env }
        ),
        action: translate('auto.components.editor.IpynbViewer.installingButton', 'Installing…')
      }
    case 'creating-venv':
      return {
        title: translate(
          'auto.components.editor.IpynbViewer.creatingVenvTitle',
          'Creating virtual environment…'
        ),
        description: translate(
          'auto.components.editor.IpynbViewer.creatingVenvDescription',
          'Creating .venv in {{folder}} and installing ipykernel into it. This can take a minute.',
          { folder }
        ),
        action: translate('auto.components.editor.IpynbViewer.creatingButton', 'Creating…')
      }
  }
}

/** Gets ipykernel into the notebook's Python: pip install, or a new .venv when pip is locked out. */
export function IpynbKernelSetupDialog({
  filePath,
  rootPath,
  setup,
  open,
  onChooseAnother
}: {
  filePath: string
  rootPath: string | null
  setup: KernelSetup | null
  open: boolean
  onChooseAnother: () => void
}): React.JSX.Element | null {
  if (!setup) {
    return null
  }
  const { base, offer, phase, error } = setup
  const working = phase !== 'idle'
  const venvParent = notebookVenvParent(filePath, rootPath)
  const copy = setupCopy(working ? phase : offer, base.name, basename(venvParent))
  const command =
    offer === 'venv' ? venvSetupCommand(base.path, venvParent) : ipykernelInstallCommand(base.path)

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !working) {
          cancelSetup(filePath)
        }
      }}
    >
      <DialogContent className="max-w-lg sm:max-w-lg" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        {error ? (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-destructive">
              {translate(
                'auto.components.editor.IpynbViewer.setupFailed',
                'That did not work. Output from Python:'
              )}
            </p>
            <pre className="scrollbar-sleek max-h-40 overflow-auto rounded-md border border-border bg-muted/50 px-3 py-2 font-mono text-xs break-all whitespace-pre-wrap text-foreground">
              {error}
            </pre>
          </div>
        ) : null}
        <div className="flex items-start gap-2 rounded-md border border-border bg-muted/50 py-1.5 pr-1.5 pl-3">
          <code className="min-w-0 flex-1 py-0.5 font-mono text-xs break-all text-foreground select-all">
            {command}
          </code>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            aria-label={translate('auto.components.editor.IpynbViewer.copyCommand', 'Copy command')}
            onClick={() =>
              void window.api.ui
                .writeClipboardText(command)
                .then(() =>
                  toast.success(
                    translate('auto.components.editor.IpynbViewer.commandCopied', 'Command copied')
                  )
                )
            }
          >
            <Copy />
          </Button>
        </div>
        <DialogFooter className="sm:justify-between">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={working}
            onClick={onChooseAnother}
          >
            {translate(
              'auto.components.editor.IpynbViewer.useAnotherPython',
              'Use another Python…'
            )}
          </Button>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={working}
              onClick={() => cancelSetup(filePath)}
            >
              {translate('auto.components.editor.IpynbViewer.7f0d7077c6', 'Cancel')}
            </Button>
            <Button
              type="button"
              size="sm"
              autoFocus
              disabled={working}
              onClick={() =>
                void (offer === 'venv'
                  ? createVirtualEnvironment(filePath, rootPath)
                  : installIpykernel(filePath))
              }
            >
              {working ? <Loader2 className="animate-spin" /> : null}
              {error && !working
                ? translate('auto.components.editor.IpynbViewer.tryAgain', 'Try again')
                : copy.action}
            </Button>
          </div>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
