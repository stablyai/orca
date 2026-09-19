import { useId, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { isWebClientLocation } from '@/lib/web-client-location'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger
} from '../ui/dialog'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { useRuntimeEnvironmentReconciliation } from './use-runtime-environment-reconciliation'

export function RuntimeEnvironmentReconciliationControl({
  onChanged
}: {
  onChanged: () => Promise<void>
}): React.JSX.Element | null {
  const state = useRuntimeEnvironmentReconciliation()
  const fieldId = useId()
  const [open, setOpen] = useState(false)
  const [primaryId, setPrimaryId] = useState('')
  const [secondaryId, setSecondaryId] = useState('')
  const requestId = useRef(crypto.randomUUID())
  const primary = state.environments.find((entry) => entry.id === primaryId)
  const secondary = state.environments.find((entry) => entry.id === secondaryId)
  const record = primary?.reconciliation
  const locked = state.busy || !state.snapshotFresh
  const canPrepare =
    primary && secondary && primary.id !== secondary.id && !secondary.reconciliation
  const label = (id: string) => state.environments.find((entry) => entry.id === id)?.name ?? id

  if (isWebClientLocation()) {
    return null
  }
  const changeOpen = (next: boolean) => {
    if (state.busy) {
      return
    }
    setOpen(next)
    if (next) {
      void state.refresh()
    } else {
      void onChanged()
    }
  }
  const transition = (action: 'activate' | 'reverse' | 'cancel') => {
    if (!record || !primary || locked) {
      return
    }
    void state.reconcile({ action, environmentId: primary.id, requestId: record.requestId })
    if (action === 'cancel') {
      requestId.current = crypto.randomUUID()
    }
  }

  return (
    <Dialog open={open} onOpenChange={changeOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {translate('runtimeReconciliation.open', 'Group server entries…')}
        </Button>
      </DialogTrigger>
      <DialogContent
        className="max-h-[calc(100vh-2rem)] overflow-y-auto scrollbar-sleek"
        showCloseButton={false}
      >
        <DialogHeader className="text-left">
          <DialogTitle>
            {translate('runtimeReconciliation.title', 'Group server entries')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'runtimeReconciliation.description',
              'Choose two saved registrations for the same host. Both grants must authenticate before grouping. This does not migrate workloads or change the active server.'
            )}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <Label htmlFor={`${fieldId}-primary`}>
            {translate('runtimeReconciliation.primary', 'Primary entry or saved group')}
          </Label>
          <Select
            value={primaryId}
            disabled={locked}
            onValueChange={(id) => {
              setPrimaryId(id)
              setSecondaryId('')
              requestId.current = crypto.randomUUID()
            }}
          >
            <SelectTrigger id={`${fieldId}-primary`} className="w-full">
              <SelectValue
                placeholder={translate('runtimeReconciliation.choose', 'Choose a registration')}
              />
            </SelectTrigger>
            <SelectContent>
              {state.environments.map((entry) => (
                <SelectItem key={entry.id} value={entry.id}>
                  {entry.name} · {entry.id}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        {primary ? (
          <p className="break-all font-mono text-xs text-muted-foreground">
            {primary.endpoints[0]?.endpoint}
          </p>
        ) : null}
        {record ? (
          <div className="space-y-2 rounded-md border border-border p-3 text-xs">
            <p className="font-medium">
              {record.stage === 'catalog-active'
                ? translate('runtimeReconciliation.active', 'Saved state: grouped in the catalog')
                : translate(
                    'runtimeReconciliation.prepared',
                    'Saved state: prepared, not activated'
                  )}
            </p>
            <p className="break-words">
              {translate('runtimeReconciliation.canonical', 'Primary entry')}:{' '}
              {label(record.canonicalEnvironmentId)}
            </p>
            {record.registrations.map((entry) => (
              <p key={entry.environmentId} className="break-all text-muted-foreground">
                {label(entry.environmentId)} · {entry.environmentId}
              </p>
            ))}
            <p className="break-all font-mono text-muted-foreground">{record.runtimeId}</p>
          </div>
        ) : primary ? (
          <div className="space-y-2">
            <Label htmlFor={`${fieldId}-secondary`}>
              {translate(
                'runtimeReconciliation.secondary',
                'Registration to group with the primary entry'
              )}
            </Label>
            <Select
              value={secondaryId}
              disabled={locked}
              onValueChange={(id) => {
                setSecondaryId(id)
                requestId.current = crypto.randomUUID()
              }}
            >
              <SelectTrigger id={`${fieldId}-secondary`} className="w-full">
                <SelectValue
                  placeholder={translate('runtimeReconciliation.choose', 'Choose a registration')}
                />
              </SelectTrigger>
              <SelectContent>
                {state.environments
                  .filter((entry) => entry.id !== primary.id && !entry.reconciliation)
                  .map((entry) => (
                    <SelectItem key={entry.id} value={entry.id}>
                      {entry.name} · {entry.id}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
            {secondary ? (
              <p className="break-all font-mono text-xs text-muted-foreground">
                {secondary.endpoints[0]?.endpoint}
              </p>
            ) : null}
          </div>
        ) : null}
        <p className="text-xs text-muted-foreground">
          {translate(
            'runtimeReconciliation.preservation',
            'Activation uses the primary entry in catalog pickers. Both original registrations, credentials, and existing resource connections remain. Reverse restores separate catalog entries; it does not roll back a workload migration.'
          )}
        </p>
        <p className="text-xs text-muted-foreground">
          {translate(
            'runtimeReconciliation.gate',
            'Preparation and activation require the experimental ownership-transfer gate. Reverse and cancel remain available with the gate off. Lifecycle changes are blocked while a saved group exists.'
          )}
        </p>
        {state.requestError ? (
          <p role="alert" className="break-words text-xs text-destructive">
            {translate(
              'runtimeReconciliation.requestError',
              'Request did not return confirmation. Check the saved state before retrying.'
            )}{' '}
            {state.requestError}
          </p>
        ) : null}
        {state.refreshError ? (
          <p role="alert" className="break-words text-xs text-destructive">
            {translate(
              'runtimeReconciliation.refreshError',
              'Saved state could not be refreshed. Actions are disabled until refresh succeeds.'
            )}{' '}
            {state.refreshError}
          </p>
        ) : null}
        {state.snapshotFresh && state.environments.length === 0 ? (
          <p className="text-xs text-muted-foreground">
            {translate(
              'runtimeReconciliation.empty',
              'Add two registrations for the same host in Servers first.'
            )}
          </p>
        ) : null}
        <p role="status" className="h-4 text-xs text-muted-foreground">
          {state.busy
            ? translate('runtimeReconciliation.working', 'Checking identity and saved state…')
            : null}
        </p>
        <DialogFooter className="sm:flex-wrap">
          <Button size="sm" variant="ghost" disabled={state.busy} onClick={() => changeOpen(false)}>
            {translate('runtimeReconciliation.close', 'Close')}
          </Button>
          <Button
            size="sm"
            variant="outline"
            disabled={state.busy}
            onClick={() => void state.refresh()}
          >
            {translate('runtimeReconciliation.refresh', 'Refresh')}
          </Button>
          {record?.stage === 'catalog-active' ? (
            <Button size="sm" disabled={locked} onClick={() => transition('reverse')}>
              {translate('runtimeReconciliation.reverse', 'Reverse grouping')}
            </Button>
          ) : record ? (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={locked}
                onClick={() => transition('cancel')}
              >
                {translate('runtimeReconciliation.cancel', 'Cancel preparation')}
              </Button>
              <Button size="sm" disabled={locked} onClick={() => transition('activate')}>
                {translate('runtimeReconciliation.activate', 'Activate grouping')}
              </Button>
            </>
          ) : (
            <Button
              size="sm"
              disabled={locked || !canPrepare}
              onClick={() => {
                if (!primary || !secondary || locked) {
                  return
                }
                void state.reconcile({
                  action: 'prepare',
                  requestId: requestId.current,
                  environmentIds: [primary.id, secondary.id],
                  canonicalEnvironmentId: primary.id
                })
              }}
            >
              {translate('runtimeReconciliation.prepare', 'Verify and prepare')}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
