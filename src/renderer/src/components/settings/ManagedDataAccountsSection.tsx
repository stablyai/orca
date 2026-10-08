import { useEffect, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../../../shared/managed-account-types'
import { Button } from '../ui/button'
import { Badge } from '../ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../ui/dialog'

type Snapshot = { opencode?: ManagedDataAccountsState; devin?: ManagedDataAccountsState }

export function ManagedDataAccountsSection({
  provider,
  target
}: {
  provider: ManagedDataAccountProvider
  target: RuntimeClientTarget
}): React.JSX.Element {
  const [state, setState] = useState<ManagedDataAccountsState | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  const environmentId = target.kind === 'environment' ? target.environmentId : null

  useEffect(() => {
    const controller = new AbortController()
    const requestTarget: RuntimeClientTarget = environmentId
      ? { kind: 'environment', environmentId }
      : { kind: 'local' }
    void callRuntimeRpc<Snapshot>(requestTarget, 'accounts.listData', undefined, {
      signal: controller.signal
    })
      .then((snapshot) => {
        if (!controller.signal.aborted) {
          setState(snapshot[provider] ?? null)
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) {
          setError(cause instanceof Error ? cause.message : String(cause))
        }
      })
    return () => controller.abort()
  }, [provider, environmentId])

  async function refresh(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const snapshot = await callRuntimeRpc<Snapshot>(target, 'accounts.listData')
      setState(snapshot[provider] ?? null)
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  async function mutate(action: 'select' | 'remove', accountId: string | null): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      setState(
        await callRuntimeRpc<ManagedDataAccountsState>(target, `accounts.${action}Data`, {
          provider,
          accountId
        })
      )
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }

  const command = `orca account add --agent ${provider}`
  return (
    <section className="space-y-3">
      <h3 className="text-sm font-semibold">
        {provider === 'opencode'
          ? translate('auto.lib.agent.catalog.e7a4ca5103', 'OpenCode')
          : translate('auto.lib.agent.catalog.fc80296033', 'Devin')}
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'accounts.managedData.description',
          'Add accounts by running this command in a terminal on the Orca host. Selection applies to new explicit agent launches on that host; direct SSH relay and Windows-hosted WSL launches use their own credentials.'
        )}
      </p>
      <code className="text-xs">{command}</code>
      <div className="flex gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            void navigator.clipboard
              .writeText(command)
              .then(() => setCopied(true))
              .catch((cause: unknown) => setError(String(cause)))
          }}
        >
          {copied
            ? translate('accounts.managedData.copied', 'Copied')
            : translate('accounts.managedData.add', 'Copy add account command')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={busy}
          onClick={() => {
            void refresh()
          }}
        >
          {translate('accounts.managedData.refresh', 'Refresh accounts')}
        </Button>
      </div>
      {!state && !error && (
        <p className="text-xs text-muted-foreground">
          {translate(
            'accounts.managedData.upgrade',
            'If accounts do not appear, update or restart the Orca host.'
          )}
        </p>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {state && (
        <>
          <div className="flex items-center justify-between gap-3">
            <span className="text-xs">
              {translate('accounts.managedData.system', 'System default')}
            </span>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || state.activeAccountId === null}
              onClick={() => {
                void mutate('select', null)
              }}
            >
              {state.activeAccountId === null
                ? translate('accounts.managedData.active', 'Active')
                : translate('accounts.managedData.select', 'Select')}
            </Button>
          </div>
          {state.accounts.map((account) => (
            <div key={account.id} className="flex items-center justify-between gap-3">
              <div className="space-y-1">
                <span className="text-xs">{account.label}</span>
                <p className="text-xs text-muted-foreground">{account.integrations.join(', ')}</p>
              </div>
              <div className="flex items-center gap-2">
                {state.activeAccountId === account.id ? (
                  <Badge variant="secondary">
                    {translate('accounts.managedData.active', 'Active')}
                  </Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      void mutate('select', account.id)
                    }}
                  >
                    {translate('accounts.managedData.select', 'Select')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => setRemoveId(account.id)}
                >
                  {translate('accounts.managedData.remove', 'Remove')}
                </Button>
              </div>
            </div>
          ))}
        </>
      )}
      <Dialog
        open={removeId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRemoveId(null)
          }
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {translate('accounts.managedData.removeTitle', 'Remove managed account?')}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'accounts.managedData.removeDescription',
                'Stop agents using this profile first. Removal deletes its saved credentials and conversation data. Your system login stays unchanged.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveId(null)}>
              {translate('accounts.managedData.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const id = removeId
                setRemoveId(null)
                if (id) {
                  void mutate('remove', id)
                }
              }}
            >
              {translate('accounts.managedData.remove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
