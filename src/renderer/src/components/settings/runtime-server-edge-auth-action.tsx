import { useEffect, useRef, useState } from 'react'
import type { PublicKnownRuntimeEnvironment } from '../../../../shared/runtime-environments'
import type { RuntimeEdgeAuthStatus } from '../../../../shared/runtime-edge-auth-types'
import { normalizeEndpointAuthHeaders } from '../../../../shared/network/endpoint-auth-headers'
import { translate } from '@/i18n/i18n'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { RuntimeEdgeAuthFields, newRuntimeEdgeAuthRow } from './runtime-edge-auth-fields'

export function RuntimeServerEdgeAuthAction({
  environment,
  onClose,
  onChanged
}: {
  environment: PublicKnownRuntimeEnvironment
  onClose: () => void
  onChanged?: () => void
}): React.JSX.Element {
  const [rows, setRows] = useState(() => [newRuntimeEdgeAuthRow()])
  const [status, setStatus] = useState<RuntimeEdgeAuthStatus | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const mounted = useRef(true)
  const saving = useRef(false)
  const normalized = normalizeEndpointAuthHeaders(rows)
  useEffect(() => {
    let current = true
    mounted.current = true
    const read = window.api.runtimeEnvironments.getEdgeAuthStatus
    if (read) {
      void read({ environmentId: environment.id }).then(
        (next) => {
          if (current) {
            setStatus(next)
          }
        },
        () => {
          if (current) {
            setError(
              translate(
                'settings.edgeAuth.readFailed',
                'Could not read edge authentication status.'
              )
            )
          }
        }
      )
    }
    return () => {
      current = false
      mounted.current = false
    }
  }, [environment.id])

  async function mutate(clear: boolean) {
    if (
      saving.current ||
      !status ||
      (!clear && (!normalized.ok || Object.keys(normalized.headers).length === 0))
    ) {
      return
    }
    saving.current = true
    setBusy(true)
    setError(null)
    try {
      const api = window.api.runtimeEnvironments
      const args = {
        environmentId: environment.id,
        expectedPairingRevision: environment.pairingRevision ?? environment.createdAt
      }
      if (clear) {
        if (!api.clearEdgeAuth) {
          throw new Error('Unavailable')
        }
        await api.clearEdgeAuth(args)
      } else {
        if (!api.saveEdgeAuth) {
          throw new Error('Unavailable')
        }
        await api.saveEdgeAuth({
          ...args,
          headers: rows.map(({ name, value }) => ({ name, value }))
        })
      }
      if (mounted.current) {
        onChanged?.()
        onClose()
      }
    } catch {
      if (mounted.current) {
        setError(
          translate(
            'settings.edgeAuth.saveFailed',
            'Could not change edge authentication. Check protected storage and reopen this form if the server pairing changed.'
          )
        )
      }
    } finally {
      saving.current = false
      if (mounted.current) {
        setBusy(false)
      }
    }
  }
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose()
        }
      }}
    >
      <DialogContent scrollable>
        <DialogHeader>
          <DialogTitle>
            {translate('settings.edgeAuth.dialogTitle', 'Edge authentication')}
          </DialogTitle>
          <DialogDescription>{environment.name}</DialogDescription>
        </DialogHeader>
        {status ? (
          <p className="text-sm text-muted-foreground">
            {status.unreadable
              ? translate(
                  'settings.edgeAuth.unreadable',
                  'Saved credentials are unreadable. Unlock protected storage, or clear them before entering new values.'
                )
              : status.configured
                ? translate(
                    'settings.edgeAuth.configured',
                    'Credentials are saved. Enter new values to replace them.'
                  )
                : translate('settings.edgeAuth.empty', 'No edge credentials are saved.')}
          </p>
        ) : null}
        <RuntimeEdgeAuthFields rows={rows} onChange={setRows} disabled={busy || !status} />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          {status?.configured ? (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => void mutate(true)}
            >
              {translate('settings.edgeAuth.clear', 'Clear credentials')}
            </Button>
          ) : null}
          <Button type="button" variant="ghost" onClick={onClose}>
            {translate('settings.edgeAuth.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            disabled={
              busy ||
              !status ||
              status.unreadable ||
              !normalized.ok ||
              Object.keys(normalized.headers).length === 0
            }
            onClick={() => void mutate(false)}
          >
            {translate('settings.edgeAuth.save', 'Save credentials')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
