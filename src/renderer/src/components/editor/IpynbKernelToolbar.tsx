import { useEffect, useState } from 'react'
import {
  ChevronDown,
  Eraser,
  FastForward,
  FolderOpen,
  Loader2,
  Plus,
  RotateCcw,
  Square
} from 'lucide-react'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
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
import { IpynbKernelSetupDialog } from './IpynbKernelSetupDialog'
import {
  offerVirtualEnvironment,
  interruptKernel,
  restartKernel,
  selectEnvironment
} from './ipynb-kernel-session'
import { useNotebookKernelState } from './ipynb-kernel-store'

type KernelState = ReturnType<typeof useNotebookKernelState>

function environmentLabel({ name, version }: PythonEnvironment): string {
  return `${name} (Python ${version})`
}

function kernelLabel({ environment, status, setup }: KernelState): string {
  if (setup?.phase === 'installing') {
    return translate('auto.components.editor.IpynbViewer.kernelInstalling', 'Installing ipykernel…')
  }
  if (setup?.phase === 'creating-venv') {
    return translate('auto.components.editor.IpynbViewer.kernelCreatingVenv', 'Creating .venv…')
  }
  if (status === 'starting') {
    return translate('auto.components.editor.IpynbViewer.kernelStarting', 'Starting…')
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
  const settling =
    kernel.status === 'starting' || (kernel.setup !== null && kernel.setup.phase !== 'idle')
  // A PATH interpreter, not the selected one: that may be the very .venv being (re)created.
  const venvBase = environments?.path[0]

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
          <DropdownMenuItem
            disabled={!venvBase}
            onSelect={() => {
              if (venvBase) {
                offerVirtualEnvironment(filePath, venvBase)
              }
            }}
          >
            <Plus />
            {translate(
              'auto.components.editor.IpynbViewer.createVenvItem',
              'Create virtual environment…'
            )}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IpynbKernelSetupDialog
        filePath={filePath}
        rootPath={rootPath}
        setup={kernel.setup}
        // The picker stands in for the dialog; closing it without a pick brings the dialog back.
        open={!pickerOpen}
        onChooseAnother={() => setPickerOpen(true)}
      />
    </div>
  )
}
