import { useCallback, useEffect, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type { CommandCodeManagedAccountsState } from '../../../../shared/managed-account-types'
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

const EMPTY_STATE: CommandCodeManagedAccountsState = { accounts: [], activeAccountId: null }

function errorMessage(error: unknown): string {
  return (
    String((error as Error)?.message ?? error)
      .replace(/^Error occurred in handler for 'commandCodeAccounts:[^']+':\s*/i, '')
      .replace(/^Error invoking remote method 'commandCodeAccounts:[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() || 'Command Code account update failed.'
  )
}

export function CommandCodeAccountsSection(): React.JSX.Element {
  const [state, setState] = useState<CommandCodeManagedAccountsState>(EMPTY_STATE)
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<
    CommandCodeManagedAccountsState['accounts'][number] | null
  >(null)

  const load = useCallback(async (): Promise<void> => {
    try {
      setState(await window.api.commandCodeAccounts.list())
      setError(null)
    } catch (loadError) {
      setError(errorMessage(loadError))
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const run = async (
    key: string,
    operation: () => Promise<CommandCodeManagedAccountsState>
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
      const next = await window.api.commandCodeAccounts.import({ label: nextLabel })
      setLabel('')
      return next
    })
  }

  return (
    <section id="accounts-command-code" className="space-y-4 scroll-mt-6">
      <div className="space-y-1">
        <h3 className="flex items-center gap-2 text-sm font-semibold">
          <AgentIcon agent="command-code" size={16} />
          {translate(
            'auto.components.settings.CommandCodeAccountsSection.provider',
            'Command Code'
          )}
        </h3>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CommandCodeAccountsSection.summary',
            'Choose the saved credential used by new local Command Code sessions.'
          )}
        </p>
      </div>

      <SearchableSetting
        title={translate(
          'auto.components.settings.CommandCodeAccountsSection.title',
          'Command Code Accounts'
        )}
        description={translate(
          'auto.components.settings.CommandCodeAccountsSection.description',
          'Import only auth.json from an existing Command Code home. Sessions, settings, taste, skills, and MCP data stay in the original home.'
        )}
        keywords={['command code', 'account', 'credentials', 'auth', 'switch']}
        className="space-y-3 py-2"
      >
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.CommandCodeAccountsSection.description',
            'Import only auth.json from an existing Command Code home. Sessions, settings, taste, skills, and MCP data stay in the original home.'
          )}
        </p>
        <div className="space-y-2">
          <Label htmlFor="command-code-account-label">
            {translate(
              'auto.components.settings.CommandCodeAccountsSection.label',
              'Account label'
            )}
          </Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id="command-code-account-label"
              value={label}
              maxLength={120}
              onChange={(event) => setLabel(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter' && label.trim() && action === null) {
                  void importAccount()
                }
              }}
              placeholder={translate(
                'auto.components.settings.CommandCodeAccountsSection.placeholder',
                'Work or Personal'
              )}
              disabled={action !== null}
            />
            <Button
              variant="outline"
              className="w-36"
              onClick={() => void importAccount()}
              disabled={!label.trim() || action !== null}
            >
              {action === 'import' ? <Loader2 className="animate-spin" /> : null}
              {action === 'import'
                ? translate(
                    'auto.components.settings.CommandCodeAccountsSection.importing',
                    'Importing…'
                  )
                : translate(
                    'auto.components.settings.CommandCodeAccountsSection.chooseHome',
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
                  'auto.components.settings.CommandCodeAccountsSection.systemDefault',
                  'System default'
                )}
              </p>
              <p className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.CommandCodeAccountsSection.systemDefaultDescription',
                  'Use COMMAND_CODE_API_KEY or ~/.commandcode/auth.json.'
                )}
              </p>
            </div>
            {state.activeAccountId === null ? (
              <Badge variant="secondary">
                {translate('auto.components.settings.CommandCodeAccountsSection.active', 'Active')}
              </Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                disabled={action !== null}
                onClick={() =>
                  void run('select:system', () =>
                    window.api.commandCodeAccounts.select({ accountId: null })
                  )
                }
              >
                {translate('auto.components.settings.CommandCodeAccountsSection.use', 'Use')}
              </Button>
            )}
          </div>

          {loading ? (
            <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" />
              {translate(
                'auto.components.settings.CommandCodeAccountsSection.loading',
                'Loading accounts…'
              )}
            </div>
          ) : null}

          {state.accounts.map((account) => {
            const active = state.activeAccountId === account.id
            return (
              <div key={account.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{account.label}</p>
                  <p className="truncate text-xs text-muted-foreground">
                    {account.userName ??
                      translate(
                        'auto.components.settings.CommandCodeAccountsSection.savedCredential',
                        'Saved Command Code credential'
                      )}
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {active ? (
                    <Badge variant="secondary">
                      {translate(
                        'auto.components.settings.CommandCodeAccountsSection.active',
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
                          window.api.commandCodeAccounts.select({ accountId: account.id })
                        )
                      }
                    >
                      {translate('auto.components.settings.CommandCodeAccountsSection.use', 'Use')}
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    aria-label={translate(
                      'auto.components.settings.CommandCodeAccountsSection.removeLabel',
                      'Remove Command Code account'
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
                'auto.components.settings.CommandCodeAccountsSection.removeTitle',
                'Remove Command Code Account?'
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.CommandCodeAccountsSection.removeDescription',
                'Orca will delete only its managed auth.json copy. The original home and system default remain unchanged.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {translate('auto.components.settings.CommandCodeAccountsSection.cancel', 'Cancel')}
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
                  window.api.commandCodeAccounts.remove({ accountId: target.id })
                )
              }}
            >
              {translate('auto.components.settings.CommandCodeAccountsSection.remove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
