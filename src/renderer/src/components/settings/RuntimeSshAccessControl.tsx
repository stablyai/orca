import { useId, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { extractIpcErrorMessage } from '@/lib/ipc-error'
import { useAppStore } from '@/store'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { SshTarget } from '../../../../shared/ssh-types'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'

type Props = {
  environment: PublicKnownRuntimeEnvironment
  disabled: boolean
  onChanged: () => Promise<void>
}

export function RuntimeSshAccessControl(props: Props): React.JSX.Element | null {
  if (isWebClientLocation() || props.environment.orcadDeployment) {
    return null
  }
  return <RuntimeSshAccessForm key={props.environment.id} {...props} />
}

function RuntimeSshAccessForm({ environment, disabled, onChanged }: Props): React.JSX.Element {
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [targets, setTargets] = useState<SshTarget[]>([])
  const [selectedTarget, setSelectedTarget] = useState('')
  const [port, setPort] = useState('6768')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const operationInFlight = useRef(false)
  const requestId = useRef(crypto.randomUUID())
  const pending = environment.pendingSshAccessOperation
  const access = environment.sshAccess
  const targetId = pending?.sshTargetId ?? selectedTarget
  const remotePort = pending?.remotePort ?? Number(port)
  const canLink =
    !!targetId && Number.isInteger(remotePort) && remotePort > 0 && remotePort <= 65535
  const locked = disabled || busy || loading

  const openForm = async (nextOpen: boolean): Promise<void> => {
    if (operationInFlight.current) {
      return
    }
    setOpen(nextOpen)
    if (!nextOpen || pending || access) {
      return
    }
    setLoading(true)
    setError(null)
    try {
      setTargets(
        (await window.api.ssh.listTargets()).filter(
          (target) => !target.owner && !target.orcadProvisioning
        )
      )
    } catch (reason) {
      setError(extractIpcErrorMessage(reason, String(reason)))
    } finally {
      setLoading(false)
    }
  }

  const run = async (operation: 'link' | 'unlink'): Promise<void> => {
    if (operationInFlight.current || locked || (operation === 'link' && !canLink)) {
      return
    }
    operationInFlight.current = true
    setBusy(true)
    setError(null)
    let succeeded = false
    try {
      const args = { selector: environment.id, requestId: pending?.requestId ?? requestId.current }
      await (operation === 'link'
        ? window.api.runtimeEnvironments.linkSshAccess({
            ...args,
            sshTargetId: targetId,
            remotePort
          })
        : window.api.runtimeEnvironments.unlinkSshAccess(args))
      succeeded = true
    } catch (reason) {
      setError(extractIpcErrorMessage(reason, String(reason)))
    }
    try {
      // Failed remote verification may still leave a durable intent to retry or cancel.
      await onChanged()
      useAppStore.getState().setSshTargetsMetadata(await window.api.ssh.listTargets())
      if (succeeded) {
        requestId.current = crypto.randomUUID()
        setOpen(false)
      }
    } catch (reason) {
      setError(extractIpcErrorMessage(reason, String(reason)))
    } finally {
      operationInFlight.current = false
      setBusy(false)
    }
  }

  return (
    <Popover open={open} onOpenChange={(value) => void openForm(value)}>
      <PopoverTrigger asChild>
        <Button type="button" variant="ghost" size="xs" disabled={disabled || busy}>
          {pending
            ? translate('runtimeSshAccess.pending', 'SSH access pending')
            : translate('runtimeSshAccess.title', 'SSH access')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80 space-y-3 p-4">
        <div className="space-y-1">
          <div className="text-sm font-medium">{environment.name}</div>
          <p className="text-xs text-muted-foreground">
            {translate(
              'runtimeSshAccess.help',
              'Use SSH to reach this paired server. This does not install or stop the server, or move its work.'
            )}
          </p>
        </div>
        {pending ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'runtimeSshAccess.recovery',
              'An interrupted SSH access change needs retry or cancellation.'
            )}
          </p>
        ) : null}
        {access || pending ? (
          <p className="break-all text-xs text-muted-foreground">
            {translate('runtimeSshAccess.port', 'Server port')}:{' '}
            {access?.remotePort ?? pending?.remotePort}
          </p>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-target`}>
                {translate('runtimeSshAccess.target', 'SSH target')}
              </Label>
              <Select value={selectedTarget} onValueChange={setSelectedTarget} disabled={locked}>
                <SelectTrigger id={`${fieldId}-target`}>
                  <SelectValue
                    placeholder={translate(
                      'runtimeSshAccess.choose',
                      'Choose an unused SSH target'
                    )}
                  />
                </SelectTrigger>
                <SelectContent>
                  {targets.map((target) => (
                    <SelectItem key={target.id} value={target.id}>
                      {target.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {!loading && targets.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {translate(
                    'runtimeSshAccess.empty',
                    'Import an unused target in SSH Hosts first. Targets with existing work cannot be linked here.'
                  )}
                </p>
              ) : null}
            </div>
            <div className="space-y-1">
              <Label htmlFor={`${fieldId}-port`}>
                {translate('runtimeSshAccess.port', 'Server port')}
              </Label>
              <Input
                id={`${fieldId}-port`}
                type="number"
                min={1}
                max={65535}
                value={port}
                onChange={(event) => setPort(event.target.value)}
                disabled={locked}
              />
              <p className="text-xs text-muted-foreground">
                {translate(
                  'runtimeSshAccess.nativePort',
                  'Use the native Orca listener port, not a reverse-proxy HTTPS port.'
                )}
              </p>
            </div>
          </div>
        )}
        {error ? (
          <p role="alert" className="break-words text-xs text-destructive">
            {error}
          </p>
        ) : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => setOpen(false)}
          >
            {translate('runtimeSshAccess.close', 'Close')}
          </Button>
          {pending?.operation === 'link' ? (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={locked}
              onClick={() => void run('unlink')}
            >
              {translate('runtimeSshAccess.cancel', 'Cancel link')}
            </Button>
          ) : null}
          <Button
            type="button"
            size="sm"
            disabled={locked || (!access && !pending && !canLink)}
            onClick={() => void run(access || pending?.operation === 'unlink' ? 'unlink' : 'link')}
          >
            {pending
              ? translate('runtimeSshAccess.retry', 'Retry')
              : access
                ? translate('runtimeSshAccess.unlink', 'Unlink SSH')
                : translate('runtimeSshAccess.link', 'Link SSH')}
          </Button>
        </div>
        <p role={busy ? 'status' : undefined} className="h-4 text-xs text-muted-foreground">
          {busy ? translate('runtimeSshAccess.working', 'Updating SSH access…') : null}
        </p>
      </PopoverContent>
    </Popover>
  )
}
