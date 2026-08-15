import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Trash2 } from 'lucide-react'
import type {
  ManagedCliHomeAccountsState,
  ManagedCliHomeProvider
} from '../../../../shared/managed-account-types'
import { translate } from '@/i18n/i18n'
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

const EMPTY_STATE: ManagedCliHomeAccountsState = { accounts: [], activeAccountId: null }

type ManagedAccountsApi = {
  list: () => Promise<ManagedCliHomeAccountsState>
  import: (args: { label: string }) => Promise<ManagedCliHomeAccountsState>
  select: (args: { accountId: string | null }) => Promise<ManagedCliHomeAccountsState>
  remove: (args: { accountId: string }) => Promise<ManagedCliHomeAccountsState>
}

function getApi(provider: ManagedCliHomeProvider): ManagedAccountsApi {
  return provider === 'grok' ? window.api.grokAccounts : window.api.geminiAccounts
}

function errorMessage(error: unknown): string {
  return (
    String((error as Error)?.message ?? error)
      .replace(/^Error occurred in handler for '[^']+':\s*/i, '')
      .replace(/^Error invoking remote method '[^']+':\s*/i, '')
      .replace(/^Error:\s*/i, '')
      .trim() ||
    translate(
      'auto.components.settings.ManagedCliHomeAccountsControl.updateFailed',
      'Provider account update failed.'
    )
  )
}

export function ManagedCliHomeAccountsControl({
  provider
}: {
  provider: ManagedCliHomeProvider
}): React.JSX.Element {
  const displayName = provider === 'grok' ? 'Grok' : 'Gemini'
  const homeVariable = provider === 'grok' ? 'GROK_HOME' : 'GEMINI_CLI_HOME'
  const [state, setState] = useState(EMPTY_STATE)
  const [label, setLabel] = useState('')
  const [loading, setLoading] = useState(true)
  const [action, setAction] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [removeTarget, setRemoveTarget] = useState<
    ManagedCliHomeAccountsState['accounts'][number] | null
  >(null)
  const loadGeneration = useRef(0)

  const load = useCallback(async () => {
    const generation = loadGeneration.current
    try {
      const api = getApi(provider)
      const next = await api.list()
      if (generation !== loadGeneration.current) {
        return
      }
      setState(next)
      setError(null)
    } catch (loadError) {
      if (generation !== loadGeneration.current) {
        return
      }
      setError(errorMessage(loadError))
    } finally {
      if (generation === loadGeneration.current) {
        setLoading(false)
      }
    }
  }, [provider])

  useEffect(() => void load(), [load])

  const busy = loading || action !== null

  const run = async (
    key: string,
    operation: () => Promise<ManagedCliHomeAccountsState>
  ): Promise<void> => {
    loadGeneration.current += 1
    setLoading(false)
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
      const api = getApi(provider)
      const next = await api.import({ label: nextLabel })
      setLabel('')
      return next
    })
  }

  return (
    <div className="w-full max-w-3xl space-y-3 py-2">
      <div className="space-y-1">
        <h4 className="text-sm font-medium">
          {translate(
            'auto.components.settings.ManagedCliHomeAccountsControl.title',
            '{{provider}} managed accounts',
            { provider: displayName }
          )}
        </h4>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.ManagedCliHomeAccountsControl.description',
            'Import a signed-in CLI home and choose which isolated home new local sessions use.'
          )}
        </p>
      </div>
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ManagedCliHomeAccountsControl.scope',
          'Only the bounded credential scope is copied. Existing sessions, the original home, and system default stay unchanged. Usage shown elsewhere still follows the system default.'
        )}
      </p>
      <div className="space-y-2">
        <Label htmlFor={`${provider}-account-label`}>
          {translate(
            'auto.components.settings.ManagedCliHomeAccountsControl.label',
            'Account label'
          )}
        </Label>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            id={`${provider}-account-label`}
            value={label}
            maxLength={120}
            onChange={(event) => setLabel(event.target.value)}
            placeholder={translate(
              'auto.components.settings.ManagedCliHomeAccountsControl.placeholder',
              'Work or Personal'
            )}
            disabled={busy}
          />
          <Button
            variant="outline"
            className="w-36"
            onClick={() => void importAccount()}
            disabled={!label.trim() || busy}
          >
            {action === 'import' ? <Loader2 className="animate-spin" /> : null}
            {translate(
              'auto.components.settings.ManagedCliHomeAccountsControl.chooseHome',
              'Choose home…'
            )}
          </Button>
        </div>
      </div>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="divide-y divide-border rounded-md border border-border">
        <div className="flex items-center justify-between gap-3 px-3 py-2.5">
          <div>
            <p className="text-sm font-medium">
              {translate(
                'auto.components.settings.ManagedCliHomeAccountsControl.systemDefault',
                'System default'
              )}
            </p>
            <p className="text-xs text-muted-foreground">
              {translate(
                'auto.components.settings.ManagedCliHomeAccountsControl.noManagedHome',
                'No Orca-managed {{variable}}.',
                { variable: homeVariable }
              )}
            </p>
          </div>
          {state.activeAccountId === null ? (
            <Badge variant="secondary">
              {translate('auto.components.settings.ManagedCliHomeAccountsControl.active', 'Active')}
            </Badge>
          ) : (
            <Button
              variant="outline"
              size="sm"
              disabled={busy}
              onClick={() => void run('system', () => getApi(provider).select({ accountId: null }))}
            >
              {translate('auto.components.settings.ManagedCliHomeAccountsControl.use', 'Use')}
            </Button>
          )}
        </div>
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-3 text-xs text-muted-foreground">
            <Loader2 className="size-3.5 animate-spin" />
            {translate(
              'auto.components.settings.ManagedCliHomeAccountsControl.loading',
              'Loading accounts…'
            )}
          </div>
        ) : null}
        {state.accounts.map((account) => (
          <div key={account.id} className="flex items-center justify-between gap-3 px-3 py-2.5">
            <p className="truncate text-sm font-medium">{account.label}</p>
            <div className="flex items-center gap-2">
              {state.activeAccountId === account.id ? (
                <Badge variant="secondary">
                  {translate(
                    'auto.components.settings.ManagedCliHomeAccountsControl.active',
                    'Active'
                  )}
                </Badge>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy}
                  onClick={() =>
                    void run(`select:${account.id}`, () =>
                      getApi(provider).select({ accountId: account.id })
                    )
                  }
                >
                  {translate('auto.components.settings.ManagedCliHomeAccountsControl.use', 'Use')}
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={translate(
                  'auto.components.settings.ManagedCliHomeAccountsControl.removeAccountLabel',
                  'Remove {{provider}} account',
                  { provider: displayName }
                )}
                disabled={busy}
                onClick={() => setRemoveTarget(account)}
              >
                <Trash2 />
              </Button>
            </div>
          </div>
        ))}
      </div>
      <Dialog open={removeTarget !== null} onOpenChange={(open) => !open && setRemoveTarget(null)}>
        <DialogContent showCloseButton={false}>
          <DialogHeader>
            <DialogTitle>
              {translate(
                'auto.components.settings.ManagedCliHomeAccountsControl.removeTitle',
                'Remove {{provider}} account?',
                { provider: displayName }
              )}
            </DialogTitle>
            <DialogDescription>
              {translate(
                'auto.components.settings.ManagedCliHomeAccountsControl.removeDescription',
                'Orca will delete only its managed credential copy. The original home remains unchanged.'
              )}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRemoveTarget(null)}>
              {translate('auto.components.settings.ManagedCliHomeAccountsControl.cancel', 'Cancel')}
            </Button>
            <Button
              variant="destructive"
              disabled={busy}
              onClick={() => {
                const target = removeTarget
                if (!target) {
                  return
                }
                setRemoveTarget(null)
                void run(`remove:${target.id}`, () =>
                  getApi(provider).remove({ accountId: target.id })
                )
              }}
            >
              {translate('auto.components.settings.ManagedCliHomeAccountsControl.remove', 'Remove')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
