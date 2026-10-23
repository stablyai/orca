import { useId, useState } from 'react'
import { translate } from '@/i18n/i18n'
import { AddApiProviderAccountSchema } from '../../../../shared/api-provider-account'
import type { ClaudeAccountActionRunner, CodexAccountActionRunner } from './accounts-pane-types'
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
import { Input } from '../ui/input'
import { Label } from '../ui/label'

type ApiProviderAccountDialogProps = { disabled: boolean } & (
  | { agent: 'claude'; runAction: ClaudeAccountActionRunner }
  | { agent: 'codex'; runAction: CodexAccountActionRunner }
)

export function ApiProviderAccountDialog(props: ApiProviderAccountDialogProps): React.JSX.Element {
  const { agent, disabled } = props
  const id = useId()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draft, setDraft] = useState({
    label: '',
    apiKey: '',
    baseUrl: '',
    model: ''
  })
  const fields = [
    { key: 'label', label: translate('accounts.api.name', 'Account name'), type: 'text' },
    { key: 'baseUrl', label: translate('accounts.api.endpoint', 'API endpoint'), type: 'url' },
    { key: 'model', label: translate('accounts.api.model', 'Model'), type: 'text' },
    { key: 'apiKey', label: translate('accounts.api.key', 'API key'), type: 'password' }
  ] as const
  function close(): void {
    setDraft((current) => ({ ...current, apiKey: '' }))
    setError('')
    setOpen(false)
  }
  async function save(): Promise<void> {
    if (busy || disabled) {
      return
    }
    const parsed = AddApiProviderAccountSchema.safeParse(draft)
    if (!parsed.success) {
      setError(
        translate('accounts.api.invalidDetails', 'Check the account details and HTTPS endpoint.')
      )
      return
    }
    setBusy(true)
    setError('')
    try {
      await (props.agent === 'claude'
        ? props.runAction(
            'adding',
            () => window.api.claudeAccounts.addApiKey(parsed.data),
            undefined,
            { rethrowErrors: true }
          )
        : props.runAction(
            'adding',
            () => window.api.codexAccounts.addApiKey(parsed.data),
            undefined,
            { rethrowErrors: true }
          ))
      close()
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : translate('accounts.api.saveFailed', 'Could not save the API account.')
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!busy) {
          if (next) {
            setOpen(true)
          } else {
            close()
          }
        }
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="xs" disabled={disabled}>
          {translate('accounts.api.add', 'Add API account')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {translate('accounts.api.title', 'Add {{agent}} API account', {
              agent: agent === 'claude' ? 'Claude' : 'Codex'
            })}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'accounts.api.description',
              'Save a provider key and endpoint for the account picker. Usage is billed by your API provider.'
            )}
          </DialogDescription>
        </DialogHeader>
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          {fields.map((field) => (
            <div className="flex flex-col gap-2" key={field.key}>
              <Label htmlFor={`${id}-${field.key}`}>{field.label}</Label>
              <Input
                id={`${id}-${field.key}`}
                type={field.type}
                value={draft[field.key]}
                autoComplete="off"
                required
                disabled={busy}
                onChange={(event) => setDraft({ ...draft, [field.key]: event.target.value })}
              />
            </div>
          ))}
          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={close}>
              {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
            </Button>
            <Button type="submit" disabled={busy || disabled || !draft.apiKey.trim()}>
              {busy
                ? translate('accounts.api.saving', 'Saving…')
                : translate('accounts.api.save', 'Save account')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
