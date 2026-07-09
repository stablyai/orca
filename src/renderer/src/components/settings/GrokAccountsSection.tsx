import { useEffect, useState, type JSX } from 'react'
import type { GrokRateLimitAccountsState } from '../../../../shared/types'
import { AgentIcon } from '@/lib/agent-catalog'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '../../store'
import { Badge } from '../ui/badge'
import { Button } from '../ui/button'
import { Label } from '../ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '../ui/dialog'
import { SearchableSetting } from './SearchableSetting'
import { Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react'
import { toast } from 'sonner'

type GrokAccountAction =
  | 'idle'
  | 'adding'
  | `reauth:${string}`
  | `remove:${string}`
  | `select:${string | 'system'}`

const EMPTY_GROK_ACCOUNTS: GrokRateLimitAccountsState = {
  accounts: [],
  activeAccountId: null
}

function getGrokAccountLabel(
  state: GrokRateLimitAccountsState,
  accountId: string | null | undefined
): string {
  if (accountId == null) {
    return 'System default'
  }
  return state.accounts.find((account) => account.id === accountId)?.email ?? 'Grok account'
}

function formatAccountTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })
}

function getGrokAccountErrorDescription(error: unknown): string {
  return String((error as Error)?.message ?? error)
    .replace(/^Error occurred in handler for 'grokAccounts:[^']+':\s*/i, '')
    .replace(/^Error invoking remote method 'grokAccounts:[^']+':\s*/i, '')
    .replace(/^Error:\s*/i, '')
    .trim()
}

export function GrokAccountsSection(): JSX.Element {
  const fetchSettings = useAppStore((s) => s.fetchSettings)
  const recordFeatureInteraction = useAppStore((s) => s.recordFeatureInteraction)
  const [grokAccounts, setGrokAccounts] = useState<GrokRateLimitAccountsState>(EMPTY_GROK_ACCOUNTS)
  const [grokAction, setGrokAction] = useState<GrokAccountAction>('idle')
  const [removeGrokAccountId, setRemoveGrokAccountId] = useState<string | null>(null)

  useEffect(() => {
    let stale = false

    const loadGrokAccounts = async (): Promise<void> => {
      try {
        const nextGrok = await window.api.grokAccounts.list()
        if (!stale) {
          setGrokAccounts(nextGrok)
        }
      } catch (error) {
        if (!stale) {
          toast.error(
            translate(
              'auto.components.settings.GrokAccountsSection.09c0c774f6',
              'Could not load Grok accounts.'
            ),
            { description: String((error as Error)?.message ?? error) }
          )
        }
      }
    }

    void loadGrokAccounts()
    return () => {
      stale = true
    }
  }, [])

  const syncGrokAccounts = async (next: GrokRateLimitAccountsState): Promise<void> => {
    setGrokAccounts(next)
    await fetchSettings()
  }

  const runGrokAccountAction = async (
    action: GrokAccountAction,
    operation: () => Promise<GrokRateLimitAccountsState>
  ): Promise<void> => {
    const previousActiveAccountId = grokAccounts.activeAccountId
    setGrokAction(action)
    try {
      const next = await operation()
      await syncGrokAccounts(next)
      recordFeatureInteraction('usage-tracking')
      const nextActiveAccountId = next.activeAccountId
      const shouldPromptRestart =
        action === 'adding' ||
        previousActiveAccountId !== nextActiveAccountId ||
        (action.startsWith('reauth:') &&
          nextActiveAccountId !== null &&
          action === `reauth:${nextActiveAccountId}`)
      if (shouldPromptRestart) {
        toast.info(
          translate(
            'auto.components.settings.GrokAccountsSection.0edb3b4c8d',
            'Grok account updated.'
          ),
          {
            description: translate(
              'auto.components.settings.GrokAccountsSection.a617606f43',
              '{{value0}} -> {{value1}}. Restart live Grok terminals before continuing old sessions.',
              {
                value0: getGrokAccountLabel(grokAccounts, previousActiveAccountId),
                value1: getGrokAccountLabel(next, nextActiveAccountId)
              }
            )
          }
        )
      }
    } catch (error) {
      toast.error(
        translate(
          'auto.components.settings.GrokAccountsSection.53eab14cd4',
          'Grok account update failed.'
        ),
        { description: getGrokAccountErrorDescription(error) }
      )
    } finally {
      setGrokAction('idle')
    }
  }

  return (
    <section id="accounts-grok" className="space-y-4 scroll-mt-6">
      <Dialog
        open={removeGrokAccountId !== null}
        onOpenChange={(open) => !open && setRemoveGrokAccountId(null)}
      >
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.settings.GrokAccountsSection.f8d3c1d153',
                'Remove Grok Account?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.GrokAccountsSection.a2d157c8b5',
                'Orca will delete the managed Grok home for this saved account. If it is currently active, Orca falls back to the system default Grok login.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveGrokAccountId(null)}>
              {translate('auto.components.settings.GrokAccountsSection.dbb9626ed1', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                const accountId = removeGrokAccountId
                if (!accountId) {
                  return
                }
                setRemoveGrokAccountId(null)
                void runGrokAccountAction(`remove:${accountId}`, () =>
                  window.api.grokAccounts.remove({ accountId })
                )
              }}
            >
              {translate(
                'auto.components.settings.GrokAccountsSection.c2d2751587',
                'Remove Account'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="grok" size={16} />
          {translate('auto.components.settings.GrokAccountsSection.0baad2d5d2', 'Grok')}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.GrokAccountsSection.9434c099b4',
            'Optional. Add Grok accounts only if you want Orca-launched Grok terminals and usage reads to switch between isolated CLI homes.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.GrokAccountsSection.603bfb6f0c',
          'Grok Accounts'
        )}
        description={translate(
          'auto.components.settings.GrokAccountsSection.caa4e95f6d',
          'Managed Grok accounts use isolated GROK_HOME directories.'
        )}
        keywords={['grok', 'account', 'rate limit', 'status bar', 'quota', 'GROK_HOME']}
        className="space-y-3 py-2"
      >
        <div className="flex items-center justify-between gap-3">
          <div className="space-y-0.5">
            <Label>
              {translate('auto.components.settings.GrokAccountsSection.94d351af4a', 'Accounts')}
            </Label>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.GrokAccountsSection.6f598b68c3',
                'New accounts are added on this device.'
              )}
            </p>
          </div>
          <Button
            variant="outline"
            size="xs"
            onClick={() => void runGrokAccountAction('adding', () => window.api.grokAccounts.add())}
            disabled={grokAction !== 'idle'}
            className="gap-1.5"
          >
            {grokAction === 'adding' ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <Plus className="size-3" />
            )}
            {translate('auto.components.settings.GrokAccountsSection.b0e948a4f9', 'Add Account')}
          </Button>
        </div>

        <div className="space-y-2">
          <button
            type="button"
            onClick={() =>
              void runGrokAccountAction('select:system', () =>
                window.api.grokAccounts.select({ accountId: null })
              )
            }
            disabled={grokAction !== 'idle'}
            className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
              grokAccounts.activeAccountId === null
                ? 'border-foreground/20 bg-accent/15'
                : 'border-border/70 hover:border-border hover:bg-accent/8'
            } disabled:cursor-default disabled:opacity-100`}
          >
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-medium">
                  {translate(
                    'auto.components.settings.GrokAccountsSection.f2a265f8c7',
                    'System default'
                  )}
                </span>
                {grokAccounts.activeAccountId === null ? (
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                  >
                    {translate('auto.components.settings.GrokAccountsSection.e74831fb6b', 'Active')}
                  </Badge>
                ) : null}
              </div>
              <span className="truncate text-[11px] text-muted-foreground">
                {translate(
                  'auto.components.settings.GrokAccountsSection.afd4795eef',
                  'Use your current system Grok login.'
                )}
              </span>
            </div>
          </button>

          {grokAccounts.accounts.length === 0 ? (
            <div className="rounded-md border border-dashed border-border/70 px-3 py-4 text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.GrokAccountsSection.264b67cb71',
                'No managed Grok accounts. Orca will use the system default Grok login until you add one here.'
              )}
            </div>
          ) : (
            grokAccounts.accounts.map((account) => {
              const isActive = grokAccounts.activeAccountId === account.id
              const isReauthing = grokAction === `reauth:${account.id}`
              const isBusy = grokAction !== 'idle'

              return (
                <div
                  key={account.id}
                  className={`flex w-full items-center justify-between gap-3 rounded-md border px-3 py-2.5 text-left transition-colors ${
                    isActive
                      ? 'border-foreground/20 bg-accent/15'
                      : 'border-border/70 hover:border-border hover:bg-accent/8'
                  }`}
                >
                  <div className="flex w-full items-center justify-between gap-3 max-md:flex-col max-md:items-start">
                    <button
                      type="button"
                      onClick={() =>
                        void runGrokAccountAction(`select:${account.id}`, () =>
                          window.api.grokAccounts.select({ accountId: account.id })
                        )
                      }
                      disabled={isBusy}
                      className="flex min-w-0 flex-1 flex-col gap-0.5 text-left disabled:cursor-default"
                    >
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-medium">{account.email}</span>
                        {isActive ? (
                          <Badge
                            variant="outline"
                            className="h-4 shrink-0 rounded px-1.5 text-[10px] font-medium leading-none text-foreground/80"
                          >
                            {translate(
                              'auto.components.settings.GrokAccountsSection.e74831fb6b',
                              'Active'
                            )}
                          </Badge>
                        ) : null}
                      </div>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {formatAccountTimestamp(account.lastAuthenticatedAt)}
                      </span>
                    </button>

                    <div className="flex shrink-0 items-center justify-end gap-1 max-md:w-full max-md:flex-wrap">
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          void runGrokAccountAction(`reauth:${account.id}`, () =>
                            window.api.grokAccounts.reauthenticate({ accountId: account.id })
                          )
                        }}
                        disabled={isBusy}
                        className="h-6 px-2 text-muted-foreground hover:text-foreground"
                      >
                        {isReauthing ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        {translate(
                          'auto.components.settings.GrokAccountsSection.8a0f870153',
                          'Re-authenticate'
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={(event) => {
                          event.stopPropagation()
                          setRemoveGrokAccountId(account.id)
                        }}
                        disabled={isBusy}
                        className="h-6 px-2 text-muted-foreground hover:text-destructive"
                      >
                        <Trash2 className="size-3" />
                        {translate(
                          'auto.components.settings.GrokAccountsSection.c2d2751587',
                          'Remove Account'
                        )}
                      </Button>
                    </div>
                  </div>
                </div>
              )
            })
          )}
        </div>
      </SearchableSetting>
    </section>
  )
}
