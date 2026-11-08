import { useEffect, useState } from 'react'
import { useTranslate } from '@/i18n/use-translate'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import type { RuntimeClientTarget } from '../../../../../../shared/runtime-client-target'
import type {
  ManagedDataAccountProvider,
  ManagedDataAccountsState
} from '../../../../../../shared/managed-account-types'
import { Button } from '../../../ui/button'
import { Badge } from '../../../ui/badge'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter
} from '../../../ui/dialog'
import { SettingsGroup } from '../../section-layout/SettingsGroup'

type Snapshot = { opencode?: ManagedDataAccountsState; devin?: ManagedDataAccountsState }

export function ManagedDataAccountsSection({
  provider,
  target
}: {
  provider: ManagedDataAccountProvider
  target: RuntimeClientTarget
}): React.JSX.Element {
  const t = useTranslate()
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
    <SettingsGroup
      title={
        provider === 'opencode'
          ? t('auto.lib.agent.catalog.e7a4ca5103', 'OpenCode')
          : t('auto.lib.agent.catalog.fc80296033', 'Devin')
      }
      description={t(
        'accounts.managedData.description',
        'Add accounts by running this command in a terminal on the Orca host. Selection applies to new explicit agent launches on that host; direct SSH relay and Windows-hosted WSL launches use their own credentials.'
      )}
    >
      <div className="space-y-3 py-3">
        <code className="text-xs">{command}</code>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void window.api.ui
                .writeClipboardText(command)
                .then(() => setCopied(true))
                .catch((cause: unknown) => setError(String(cause)))
            }}
          >
            {copied
              ? t('accounts.managedData.copied', 'Copied')
              : t('accounts.managedData.add', 'Copy add account command')}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              void refresh()
            }}
          >
            {t('accounts.managedData.refresh', 'Refresh accounts')}
          </Button>
        </div>
        {!state && !error && (
          <p className="text-xs text-muted-foreground">
            {t(
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
      </div>
      {state && (
        <>
          <div data-settings-row="" className="flex items-center justify-between gap-3 py-2">
            <span className="text-xs">{t('accounts.managedData.system', 'System default')}</span>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy || state.activeAccountId === null}
              onClick={() => {
                void mutate('select', null)
              }}
            >
              {state.activeAccountId === null
                ? t('accounts.managedData.active', 'Active')
                : t('accounts.managedData.select', 'Select')}
            </Button>
          </div>
          {state.accounts.map((account) => (
            <div
              key={account.id}
              data-settings-row=""
              className="flex items-center justify-between gap-3 py-2"
            >
              <div className="space-y-1">
                <span className="text-xs">{account.label}</span>
                <p className="text-xs text-muted-foreground">{account.integrations.join(', ')}</p>
              </div>
              <div className="flex items-center gap-2">
                {state.activeAccountId === account.id ? (
                  <Badge variant="secondary">{t('accounts.managedData.active', 'Active')}</Badge>
                ) : (
                  <Button
                    variant="ghost"
                    size="xs"
                    disabled={busy}
                    onClick={() => {
                      void mutate('select', account.id)
                    }}
                  >
                    {t('accounts.managedData.select', 'Select')}
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={busy}
                  onClick={() => setRemoveId(account.id)}
                >
                  {t('accounts.managedData.remove', 'Remove')}
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
              {t('accounts.managedData.removeTitle', 'Remove managed account?')}
            </DialogTitle>
            <DialogDescription>
              {t(
                'accounts.managedData.removeDescription',
                'Stop agents using this profile first. Removal deletes its saved credentials and conversation data. Your system login stays unchanged.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveId(null)}>
              {t('accounts.managedData.cancel', 'Cancel')}
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
              {t('accounts.managedData.remove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </SettingsGroup>
  )
}
