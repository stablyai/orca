import { useCallback, useEffect, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { KimiManagedAccountsState } from '../../../../shared/managed-account-types'
import type { InactiveAccountUsage, ProviderRateLimits } from '../../../../shared/rate-limit-types'
import { translate } from '@/i18n/i18n'
import { AgentIcon } from '@/lib/agent-catalog'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { SearchableSetting } from './SearchableSetting'
import { useAppStore } from '../../store'

const EMPTY_STATE: KimiManagedAccountsState = { accounts: [], activeAccountId: null }
const EMPTY_INACTIVE_USAGE: InactiveAccountUsage[] = []

function errorMessage(error: unknown): string {
  return (
    String((error as Error)?.message ?? error)
      .replace(/^Error occurred in handler for 'kimiAccounts:[^']+':\s*/i, '')
      .replace(/^Error invoking remote method 'kimiAccounts:[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'Kimi account update failed.'
  )
}

function usageSummary(
  limits: ProviderRateLimits | null | undefined,
  inactive?: InactiveAccountUsage
): string | null {
  if (inactive?.isFetching) {
    return translate('auto.components.settings.KimiAccountsSection.usageLoading', 'Loading usage…')
  }
  const snapshot = inactive?.rateLimits ?? limits
  const windows = [snapshot?.session, snapshot?.weekly].filter(
    (window): window is NonNullable<ProviderRateLimits['session']> => Boolean(window)
  )
  if (windows.length > 0) {
    return windows.map((window) => `${Math.round(window.usedPercent)}% used`).join(' · ')
  }
  if (snapshot?.status === 'error' || snapshot?.status === 'unavailable') {
    return translate(
      'auto.components.settings.KimiAccountsSection.usageUnavailable',
      'Usage unavailable'
    )
  }
  return null
}

export function KimiAccountsSection(): React.JSX.Element {
  const kimiUsage = useAppStore((store) => store.rateLimits.kimi)
  const inactiveKimiAccountState = useAppStore((store) => store.rateLimits.inactiveKimiAccounts)
  const inactiveKimiAccounts = inactiveKimiAccountState ?? EMPTY_INACTIVE_USAGE
  const fetchInactiveKimiAccountUsage = useAppStore((store) => store.fetchInactiveKimiAccountUsage)
  const [state, setState] = useState<KimiManagedAccountsState>(EMPTY_STATE)
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<
    KimiManagedAccountsState['accounts'][number] | null
  >(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await window.api.kimiAccounts.list())
      setError(null)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
    void fetchInactiveKimiAccountUsage()
  }, [fetchInactiveKimiAccountUsage, load])

  const run = async (
    key: string,
    operation: () => Promise<KimiManagedAccountsState>
  ): Promise<void> => {
    setAction(key)
    setError(null)
    try {
      setState(await operation())
    } catch (operationError) {
      const message = errorMessage(operationError)
      if (!message.toLowerCase().includes('cancelled')) {
        setError(message)
      }
    } finally {
      setAction(null)
    }
  }

  const importAccount = async (): Promise<void> => {
    const nextLabel = label.trim()
    if (!nextLabel) {
      return
    }
    await run('import', async () => {
      const next = await window.api.kimiAccounts.import({ label: nextLabel })
      setLabel('')
      return next
    })
  }

  const loginAccount = async (): Promise<void> => {
    const nextLabel = label.trim()
    if (!nextLabel) {
      return
    }
    await run('login', async () => {
      const next = await window.api.kimiAccounts.login({ label: nextLabel })
      setLabel('')
      return next
    })
  }

  return (
    <section id="accounts-kimi" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="kimi" size={16} />
          {translate('auto.components.settings.KimiAccountsSection.8c3ea0c4de', 'Kimi')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.KimiAccountsSection.669b65ef25',
            'Keep separate Kimi Code credentials in Orca-managed homes.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.KimiAccountsSection.94ef38fe29',
          'Kimi Accounts'
        )}
        description={translate(
          'auto.components.settings.KimiAccountsSection.271d3f21b7',
          'Import config.toml and credentials from an existing Kimi Code home. Sessions and logs stay in the original home.'
        )}
        keywords={['kimi', 'account', 'credentials', 'config', 'switch']}
        className="space-y-3 py-2"
      >
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.KimiAccountsSection.271d3f21b7',
            'Import config.toml and credentials from an existing Kimi Code home. Sessions and logs stay in the original home.'
          )}
        </p>
        <div className="space-y-2">
          <div className="space-y-1">
            <Label htmlFor="kimi-account-label">
              {translate(
                'auto.components.settings.KimiAccountsSection.8fdf12d92a',
                'Account label'
              )}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.KimiAccountsSection.e9c5a73d12',
                'Kimi does not expose a stable account email here, so this label identifies the saved login.'
              )}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="kimi-account-label"
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && label.trim() && action === null) {
                  void loginAccount()
                }
              }}
              placeholder={translate(
                'auto.components.settings.KimiAccountsSection.99743f7be2',
                'Work or Personal'
              )}
              disabled={action !== null}
            />
            <Button
              className="w-32"
              onClick={() => void loginAccount()}
              disabled={!label.trim() || action !== null}
            >
              {action === 'login' ? <Loader2 className="animate-spin" /> : null}
              {action === 'login'
                ? translate('auto.components.settings.KimiAccountsSection.signingIn', 'Signing in…')
                : translate('auto.components.settings.KimiAccountsSection.signIn', 'Sign in')}
            </Button>
            <Button
              variant="outline"
              className="w-36"
              onClick={() => void importAccount()}
              disabled={!label.trim() || action !== null}
            >
              {action === 'import' ? <Loader2 className="animate-spin" /> : null}
              {action === 'import'
                ? translate('auto.components.settings.KimiAccountsSection.1ab6e84634', 'Importing…')
                : translate(
                    'auto.components.settings.KimiAccountsSection.6613d80a55',
                    'Choose home…'
                  )}
            </Button>
          </div>
        </div>

        {error ? (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        ) : null}

        <div className="divide-y divide-border rounded-md border border-border">
          <div className="flex items-center justify-between gap-3 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">
                {translate(
                  'auto.components.settings.KimiAccountsSection.42fd0923b8',
                  'System default'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.KimiAccountsSection.34a8524e96',
                  'Use the current KIMI_CODE_HOME or ~/.kimi-code.'
                )}
              </p>
            </div>
            {state.activeAccountId === null ? (
              <Badge variant="secondary">
                {translate('auto.components.settings.KimiAccountsSection.d4f6feeb1b', 'Active')}
              </Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={action !== null}
                onClick={() =>
                  void run('select:system', () =>
                    window.api.kimiAccounts.select({ accountId: null })
                  )
                }
              >
                {translate('auto.components.settings.KimiAccountsSection.47606f877d', 'Use')}
              </Button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {translate(
                'auto.components.settings.KimiAccountsSection.797390b07e',
                'Loading accounts…'
              )}
            </div>
          ) : null}

          {state.accounts.map((account) => {
            const active = state.activeAccountId === account.id
            const inactiveUsage = inactiveKimiAccounts.find(
              (entry) => entry.accountId === account.id
            )
            const usage = usageSummary(active ? kimiUsage : null, inactiveUsage)
            return (
              <div key={account.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{account.label}</p>
                  <p className="text-xs text-muted-foreground">
                    {translate(
                      'auto.components.settings.KimiAccountsSection.c91036794c',
                      'Orca-managed Kimi home'
                    )}
                  </p>
                  {usage ? <p className="text-xs text-muted-foreground">{usage}</p> : null}
                </div>
                <div className="flex items-center gap-2">
                  {active ? (
                    <Badge variant="secondary">
                      {translate(
                        'auto.components.settings.KimiAccountsSection.d4f6feeb1b',
                        'Active'
                      )}
                    </Badge>
                  ) : (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={action !== null}
                      onClick={() =>
                        void run(`select:${account.id}`, () =>
                          window.api.kimiAccounts.select({ accountId: account.id })
                        )
                      }
                    >
                      {translate('auto.components.settings.KimiAccountsSection.47606f877d', 'Use')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    aria-label={translate(
                      'auto.components.settings.KimiAccountsSection.214d83fdea',
                      'Remove Kimi account'
                    )}
                    disabled={action !== null}
                    onClick={() => setRemoveTarget(account)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              </div>
            )
          })}
        </div>
      </SearchableSetting>

      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.settings.KimiAccountsSection.f8e0f92e83',
                'Remove Kimi Account?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.KimiAccountsSection.b2767a4027',
                'Orca will delete only this managed copy of the Kimi config and credentials. The original home and the system default remain unchanged.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {translate('auto.components.settings.KimiAccountsSection.6fe23e65cd', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={action !== null}
              onClick={() => {
                const target = removeTarget
                if (!target) {
                  return
                }
                setRemoveTarget(null)
                void run(`remove:${target.id}`, () =>
                  window.api.kimiAccounts.remove({ accountId: target.id })
                )
              }}
            >
              {translate('auto.components.settings.KimiAccountsSection.03ca5c8176', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
