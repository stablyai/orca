import { DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { RefreshCw } from 'lucide-react'
import { LoadingSpinner } from '@/components/LoadingSpinner'
import { translate } from '@/i18n/i18n'
import type { WslHostDistro } from '../../../../shared/wsl-host-types'
import { getWslHostServerFilesMissingLabel } from './wsl-host-row-status'

export function wslDistroStateLabel(distro: WslHostDistro): string {
  if (distro.version === 1) {
    return translate('auto.components.sidebar.AddWslHostFormPanel.wsl1', 'WSL 1 · not supported')
  }
  if (distro.environmentId) {
    return translate('auto.components.sidebar.AddWslHostFormPanel.added', 'Already a host')
  }
  return distro.state === 'running'
    ? translate('auto.components.sidebar.AddWslHostFormPanel.running', 'Running')
    : translate('auto.components.sidebar.AddWslHostFormPanel.stopped', 'Stopped')
}

export function canAddWslDistro(distro: WslHostDistro | undefined): boolean {
  return distro !== undefined && distro.version !== 1 && distro.environmentId === null
}

export function AddWslHostFormPanel({
  distros,
  loading,
  refreshing,
  selectedDistro,
  error,
  adding,
  serverFilesMissing,
  onSelectDistro,
  onRefresh,
  onSubmit,
  onCancel
}: {
  distros: readonly WslHostDistro[]
  loading: boolean
  refreshing: boolean
  selectedDistro: string
  error: string | null
  adding: boolean
  /** This build cannot run WSL hosts; nothing here may be chosen or submitted. */
  serverFilesMissing: boolean
  onSelectDistro: (name: string) => void
  /** Re-reads the registered distros, e.g. after `wsl --import` in another window. */
  onRefresh: () => void
  onSubmit: () => void
  onCancel: () => void
}): React.JSX.Element {
  const selected = distros.find((distro) => distro.name === selectedDistro)
  // A disabled option can't show its refusal, so the conversion command is spelled out here.
  const wsl1Distro = distros.find((distro) => distro.version === 1)
  const stopped = selected?.state === 'stopped' && canAddWslDistro(selected)
  return (
    <>
      <DialogHeader>
        <DialogTitle>
          {translate('auto.components.sidebar.AddWslHostFormPanel.title', 'Add WSL distro')}
        </DialogTitle>
        <DialogDescription>
          {translate(
            'auto.components.sidebar.AddWslHostFormPanel.description',
            'Orca runs its server inside the distro, so git, files and terminals run natively in Linux. Projects in this distro that you opened through \\\\wsl.localhost move to this host automatically once their terminals are idle; projects on a Windows drive (/mnt/…) stay on this computer. You can bring a moved project back from the sidebar.'
          )}
        </DialogDescription>
      </DialogHeader>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between gap-2">
          <Label htmlFor="add-wsl-distro">
            {translate('auto.components.sidebar.AddWslHostFormPanel.distro', 'Distro')}
          </Label>
          {serverFilesMissing ? null : (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onRefresh}
              disabled={adding || refreshing}
            >
              {refreshing ? <LoadingSpinner className="size-3" /> : <RefreshCw />}
              {translate('auto.components.sidebar.AddWslHostFormPanel.refresh', 'Refresh')}
            </Button>
          )}
        </div>
        <Select
          value={selectedDistro}
          // Radix resets its hidden native select to empty; ignore this non-user choice.
          onValueChange={(name) => name && onSelectDistro(name)}
          disabled={adding || loading || serverFilesMissing}
        >
          <SelectTrigger id="add-wsl-distro" className="w-full">
            <SelectValue
              placeholder={
                loading
                  ? translate(
                      'auto.components.sidebar.AddWslHostFormPanel.loading',
                      'Looking for WSL distros…'
                    )
                  : translate(
                      'auto.components.sidebar.AddWslHostFormPanel.placeholder',
                      'Choose a distro'
                    )
              }
            />
          </SelectTrigger>
          <SelectContent>
            {distros.map((distro) => (
              <SelectItem key={distro.name} value={distro.name} disabled={!canAddWslDistro(distro)}>
                <span className="truncate">{distro.name}</span>
                <span className="text-muted-foreground">{wslDistroStateLabel(distro)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {serverFilesMissing ? (
          <p role="alert" className="text-xs text-destructive">
            {getWslHostServerFilesMissingLabel()}
          </p>
        ) : null}
        {!loading && !serverFilesMissing && distros.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddWslHostFormPanel.none',
              'No WSL distros found. Install one with: wsl --install'
            )}
          </p>
        ) : null}
        {wsl1Distro ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddWslHostFormPanel.wsl1Hint',
              'WSL 1 distros can’t be hosts. Convert one in a Windows terminal with: wsl --set-version {{value0}} 2',
              { value0: wsl1Distro.name }
            )}
          </p>
        ) : null}
        {stopped ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.sidebar.AddWslHostFormPanel.stoppedHint',
              '{{value0}} is stopped. Adding it starts it.',
              { value0: selected.name }
            )}
          </p>
        ) : null}
        {adding ? (
          <p className="text-xs text-muted-foreground" aria-live="polite">
            {translate(
              'auto.components.sidebar.AddWslHostFormPanel.addingHint',
              'Installing and starting the Orca server in the distro. The first time can take a minute.'
            )}
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}
      </div>

      <DialogFooter className="sm:justify-between">
        <span />
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="outline" onClick={onCancel} disabled={adding}>
            {translate('auto.components.sidebar.AddRemoteHostDialog.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            onClick={onSubmit}
            disabled={adding || serverFilesMissing || !canAddWslDistro(selected)}
          >
            {adding ? <LoadingSpinner className="size-4" /> : null}
            {adding
              ? translate('auto.components.sidebar.AddWslHostFormPanel.adding', 'Setting up…')
              : stopped
                ? translate(
                    'auto.components.sidebar.AddWslHostFormPanel.startAndAdd',
                    'Start and add'
                  )
                : translate('auto.components.sidebar.AddWslHostFormPanel.add', 'Add host')}
          </Button>
        </div>
      </DialogFooter>
    </>
  )
}
