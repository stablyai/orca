import { useEffect, type ReactNode } from 'react'
import { toast } from 'sonner'
import { FolderOpen, Loader2, RefreshCw } from 'lucide-react'
import { DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { parseWslUncPath } from '../../../../shared/wsl-paths'
import { useWslDistroOptions } from './use-wsl-distro-options'
import { translate } from '@/i18n/i18n'

type WslSourcePickerProps = {
  hostSelector?: ReactNode
  wslDistro: string
  wslPath: string
  wslError: string | null
  isAddingWsl: boolean
  addProjectBusyLabel: string | null
  onDistroChange: (distro: string) => void
  onPathChange: (path: string) => void
  onAddWsl: (kind: 'git' | 'folder') => void
}

export function WslSourcePicker({
  hostSelector,
  wslDistro,
  wslPath,
  wslError,
  isAddingWsl,
  addProjectBusyLabel,
  onDistroChange,
  onPathChange,
  onAddWsl
}: WslSourcePickerProps): React.JSX.Element {
  const { options, loading, refresh } = useWslDistroOptions()

  useEffect(() => {
    // Why: mirror the settings runtime picker's default — preselect the first
    // distro once options resolve, but never override an explicit user choice.
    if (!wslDistro && options.default) {
      onDistroChange(options.default)
    }
  }, [onDistroChange, options.default, wslDistro])

  const distroDisabled = loading || !options.available || options.distros.length === 0
  const submitDisabled = isAddingWsl || !wslDistro.trim() || !wslPath.trim()

  const handleBrowse = async (): Promise<void> => {
    if (!wslDistro) {
      return
    }
    const picked = await window.api.shell.pickDirectory({
      defaultPath: `\\\\wsl.localhost\\${wslDistro}\\`
    })
    if (!picked) {
      return
    }
    const parsed = parseWslUncPath(picked)
    if (!parsed) {
      toast.error(
        translate(
          'auto.components.sidebar.WslSourcePicker.browseOutsideDistro',
          'Choose a folder inside the selected WSL distro.'
        )
      )
      return
    }
    onDistroChange(parsed.distro)
    onPathChange(parsed.linuxPath)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.sidebar.WslSourcePicker.title', 'Add a WSL project')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.WslSourcePicker.description',
            'Open a Git repository or folder from a WSL distro.'
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-3 pt-2">
        {hostSelector}
        <div className="space-y-1">
          <label
            htmlFor="wsl-distro"
            className="block text-[11px] font-medium text-muted-foreground"
          >
            {translate('auto.components.sidebar.WslSourcePicker.distro', 'Distro')}
          </label>
          <div className="flex gap-2">
            <Select value={wslDistro} onValueChange={onDistroChange} disabled={distroDisabled}>
              <SelectTrigger id="wsl-distro" size="sm" className="h-11 min-w-0 flex-1">
                <SelectValue
                  placeholder={
                    options.available
                      ? translate(
                          'auto.components.sidebar.WslSourcePicker.selectDistro',
                          'Select distro'
                        )
                      : translate(
                          'auto.components.sidebar.WslSourcePicker.wslNotAvailable',
                          'WSL not available'
                        )
                  }
                />
              </SelectTrigger>
              <SelectContent>
                {options.distros.map((distro) => (
                  <SelectItem key={distro} value={distro}>
                    {distro}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  onClick={() => void refresh()}
                  disabled={loading}
                  aria-label={translate(
                    'auto.components.sidebar.WslSourcePicker.refreshDistros',
                    'Refresh distros'
                  )}
                >
                  <RefreshCw className={cn('size-4', loading && 'animate-spin')} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.sidebar.WslSourcePicker.refreshDistros',
                  'Refresh distros'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
          {!loading && options.available && options.distros.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.WslSourcePicker.noDistros',
                'No WSL distros found. Install one, then refresh.'
              )}
            </p>
          ) : null}
          {!loading && !options.available ? (
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.sidebar.WslSourcePicker.unavailable',
                'WSL is not available on this computer.'
              )}
            </p>
          ) : null}
        </div>

        <div className="space-y-1">
          <label
            htmlFor="wsl-project-path"
            className="block text-[11px] font-medium text-muted-foreground"
          >
            {translate('auto.components.sidebar.WslSourcePicker.linuxPath', 'Linux path')}
          </label>
          <div className="flex gap-2">
            <Input
              id="wsl-project-path"
              value={wslPath}
              onChange={(event) => onPathChange(event.target.value)}
              placeholder={translate(
                'auto.components.sidebar.WslSourcePicker.linuxPathPlaceholder',
                '/home/user/project'
              )}
              className="h-11 min-w-0 flex-1 font-mono text-sm"
              disabled={isAddingWsl}
              spellCheck={false}
            />
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  className="h-11 w-11 shrink-0"
                  onClick={() => void handleBrowse()}
                  disabled={isAddingWsl || !wslDistro}
                  aria-label={translate(
                    'auto.components.sidebar.WslSourcePicker.browseWsl',
                    'Browse WSL filesystem'
                  )}
                >
                  <FolderOpen className="size-4" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={4}>
                {translate(
                  'auto.components.sidebar.WslSourcePicker.browseWsl',
                  'Browse WSL filesystem'
                )}
              </TooltipContent>
            </Tooltip>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Button onClick={() => onAddWsl('git')} disabled={submitDisabled} className="h-10">
            {translate('auto.components.sidebar.WslSourcePicker.addGitProject', 'Add Git Project')}
          </Button>
          <Button
            onClick={() => onAddWsl('folder')}
            disabled={submitDisabled}
            variant="outline"
            className="h-10"
          >
            {translate('auto.components.sidebar.WslSourcePicker.openAsFolder', 'Open as Folder')}
          </Button>
        </div>

        {wslError ? <p className="text-xs text-destructive">{wslError}</p> : null}

        {isAddingWsl && addProjectBusyLabel ? (
          <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 shrink-0 animate-spin" />
            <span>{addProjectBusyLabel}</span>
          </div>
        ) : null}
      </div>
    </>
  )
}
