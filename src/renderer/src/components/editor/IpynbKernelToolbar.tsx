import { useEffect, useState } from 'react'
import {
  ChevronDown,
  Eraser,
  FastForward,
  FolderOpen,
  Loader2,
  RotateCcw,
  Square
} from 'lucide-react'
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
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { translate } from '@/i18n/i18n'
import { cn } from '@/lib/utils'
import type {
  PythonEnvironment,
  PythonEnvironments
} from '../../../../shared/notebook-kernel-types'
import { IpynbToolbarButton } from './IpynbCellToolbar'
import {
  cancelPendingStart,
  installIpykernel,
  ipykernelInstallCommand,
  interruptKernel,
  restartKernel,
  selectEnvironment
} from './ipynb-kernel-session'
import { useNotebookKernelState } from './ipynb-kernel-store'

type KernelState = ReturnType<typeof useNotebookKernelState>

function environmentLabel({ name, version }: PythonEnvironment): string {
  return `${name} (Python ${version})`
}

function kernelLabel({ environment, status }: KernelState): string {
  if (status === 'starting') {
    return translate('auto.components.editor.IpynbViewer.kernelStarting', 'Starting…')
  }
  if (status === 'installing') {
    return translate('auto.components.editor.IpynbViewer.kernelInstalling', 'Installing ipykernel…')
  }
  if (status === 'dead') {
    return translate('auto.components.editor.IpynbViewer.kernelDead', 'Kernel died')
  }
  return environment
    ? environmentLabel(environment)
    : translate('auto.components.editor.IpynbViewer.selectKernel', 'Select Kernel')
}

function EnvironmentItems({ environments }: { environments: PythonEnvironment[] }) {
  return environments.map((environment) => (
    <DropdownMenuRadioItem key={environment.path} value={environment.path}>
      <span className="flex min-w-0 flex-col">
        <span>{environmentLabel(environment)}</span>
        <span className="truncate text-xs text-muted-foreground">{environment.path}</span>
      </span>
    </DropdownMenuRadioItem>
  ))
}

async function browseForPython(filePath: string): Promise<void> {
  const path = await window.api.shell.pickAttachment()
  if (!path) {
    return
  }
  const environment = await window.api.notebook.describePython({ path })
  if (environment) {
    selectEnvironment(filePath, environment)
  } else {
    toast.error(
      translate(
        'auto.components.editor.IpynbViewer.notPython',
        'That file is not a Python interpreter.'
      )
    )
  }
}

/** The notebook header's kernel pill (interpreter picker) and kernel actions. */
export function IpynbKernelToolbar({
  filePath,
  rootPath,
  onRunAll,
  onClearAll
}: {
  filePath: string
  rootPath: string | null
  onRunAll: () => void
  onClearAll: () => void
}): React.JSX.Element {
  const kernel = useNotebookKernelState(filePath)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [environments, setEnvironments] = useState<PythonEnvironments | null>(null)
  const settling = kernel.status === 'starting' || kernel.status === 'installing'

  useEffect(() => {
    if (!pickerOpen) {
      return
    }
    let current = true
    void window.api.notebook.listPythonEnvironments({ filePath, rootPath }).then((found) => {
      if (current) {
        setEnvironments(found)
      }
    })
    return () => {
      current = false
    }
  }, [filePath, pickerOpen, rootPath])

  const choose = (path: string): void => {
    const environment = [...(environments?.workspace ?? []), ...(environments?.path ?? [])].find(
      (candidate) => candidate.path === path
    )
    if (environment) {
      selectEnvironment(filePath, environment)
    }
  }

  return (
    <div className="flex items-center gap-1">
      {kernel.busy ? (
        <IpynbToolbarButton
          label={translate('auto.components.editor.IpynbViewer.interrupt', 'Interrupt')}
          onClick={() => interruptKernel(filePath)}
        >
          <Square />
        </IpynbToolbarButton>
      ) : null}
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.restart', 'Restart kernel')}
        disabled={!kernel.environment || settling}
        onClick={() => restartKernel(filePath)}
      >
        <RotateCcw />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.runAll', 'Run all')}
        onClick={onRunAll}
      >
        <FastForward />
      </IpynbToolbarButton>
      <IpynbToolbarButton
        label={translate('auto.components.editor.IpynbViewer.clearAll', 'Clear all outputs')}
        onClick={onClearAll}
      >
        <Eraser />
      </IpynbToolbarButton>
      {kernel.interruptStalled ? (
        <Button type="button" variant="link" size="xs" onClick={() => restartKernel(filePath)}>
          {translate(
            'auto.components.editor.IpynbViewer.notResponding',
            'Not responding. Restart kernel'
          )}
        </Button>
      ) : null}
      <DropdownMenu open={pickerOpen} onOpenChange={setPickerOpen}>
        <DropdownMenuTrigger asChild>
          <Button type="button" variant="ghost" size="xs" disabled={settling}>
            {settling ? (
              <Loader2 className="size-3 animate-spin" />
            ) : kernel.status === 'ready' ? (
              <span
                className={cn(
                  'size-2 rounded-full',
                  kernel.busy ? 'animate-pulse bg-muted-foreground' : 'bg-status-success'
                )}
              />
            ) : null}
            <span className={cn(kernel.status === 'dead' && 'text-destructive')}>
              {kernelLabel(kernel)}
            </span>
            <ChevronDown className="size-3" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-md">
          {environments === null ? (
            <DropdownMenuItem disabled>
              <Loader2 className="animate-spin" />
              {translate(
                'auto.components.editor.IpynbViewer.findingPython',
                'Finding Python environments…'
              )}
            </DropdownMenuItem>
          ) : (
            <DropdownMenuRadioGroup value={kernel.environment?.path ?? ''} onValueChange={choose}>
              {environments.workspace.length > 0 ? (
                <DropdownMenuLabel>
                  {translate('auto.components.editor.IpynbViewer.recommended', 'Recommended')}
                </DropdownMenuLabel>
              ) : null}
              <EnvironmentItems environments={environments.workspace} />
              {environments.path.length > 0 ? (
                <DropdownMenuLabel>
                  {translate('auto.components.editor.IpynbViewer.pythonOnPath', 'Python on PATH')}
                </DropdownMenuLabel>
              ) : null}
              <EnvironmentItems environments={environments.path} />
            </DropdownMenuRadioGroup>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem onSelect={() => void browseForPython(filePath)}>
            <FolderOpen />
            {translate('auto.components.editor.IpynbViewer.browsePython', 'Browse for Python…')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IpynbMissingKernelDialog
        filePath={filePath}
        kernel={kernel}
        // The picker stands in for the dialog; closing it without a pick brings the dialog back.
        open={kernel.status === 'missing-ipykernel' && !pickerOpen}
        onChooseAnother={() => setPickerOpen(true)}
      />
    </div>
  )
}

function IpynbMissingKernelDialog({
  filePath,
  kernel,
  open,
  onChooseAnother
}: {
  filePath: string
  kernel: KernelState
  open: boolean
  onChooseAnother: () => void
}): React.JSX.Element {
  const command = kernel.environment ? ipykernelInstallCommand(kernel.environment.path) : ''
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          cancelPendingStart(filePath)
        }
      }}
    >
      <DialogContent className="max-w-md sm:max-w-md" showCloseButton={false}>
        <DialogHeader>
          <DialogTitle className="text-sm">
            {translate(
              'auto.components.editor.IpynbViewer.missingIpykernelTitle',
              'Install ipykernel?'
            )}
          </DialogTitle>
          <DialogDescription className="text-xs">
            {translate(
              'auto.components.editor.IpynbViewer.missingIpykernel',
              "Running cells with '{{env}}' requires the ipykernel package.",
              { env: kernel.environment?.name ?? '' }
            )}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => cancelPendingStart(filePath)}
          >
            {translate('auto.components.editor.IpynbViewer.7f0d7077c6', 'Cancel')}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => void window.api.ui.writeClipboardText(command)}
          >
            {translate('auto.components.editor.IpynbViewer.copyCommand', 'Copy command')}
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={onChooseAnother}>
            {translate('auto.components.editor.IpynbViewer.chooseAnother', 'Choose Another')}
          </Button>
          <Button type="button" size="sm" autoFocus onClick={() => void installIpykernel(filePath)}>
            {translate('auto.components.editor.IpynbViewer.install', 'Install')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
