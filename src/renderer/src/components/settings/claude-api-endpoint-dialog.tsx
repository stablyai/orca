import { useEffectEvent, useId, useLayoutEffect, useState } from 'react'
import { LoaderCircle, Pencil, Plus } from 'lucide-react'
import { translate } from '@/i18n/i18n'
import { useMountedRef } from '@/hooks/useMountedRef'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { CLAUDE_API_ENDPOINT_PRESETS } from '../../../../shared/claude-api-endpoint-presets'
import type {
  ClaudeManagedAccountSummary,
  ClaudeRateLimitAccountsState
} from '../../../../shared/managed-account-types'

type ClaudeApiEndpointDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The endpoint account being edited; omitted when adding one. */
  account?: ClaudeManagedAccountSummary | null
  onSaved: (state: ClaudeRateLimitAccountsState) => void
}

export function ClaudeApiEndpointDialog({
  open,
  onOpenChange,
  account,
  onSaved
}: ClaudeApiEndpointDialogProps): React.JSX.Element {
  const mountedRef = useMountedRef()
  const labelId = useId()
  const baseUrlId = useId()
  const tokenId = useId()
  const modelId = useId()
  const smallFastModelId = useId()
  const modelListId = useId()
  const errorId = useId()
  const [label, setLabel] = useState('')
  const [baseUrl, setBaseUrl] = useState('')
  const [authToken, setAuthToken] = useState('')
  const [model, setModel] = useState('')
  const [smallFastModel, setSmallFastModel] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const editing = Boolean(account)

  // The token always starts empty: main never returns it, and a blank one keeps the saved token.
  const seed = useEffectEvent(() => {
    setLabel(account?.email ?? '')
    setBaseUrl(account?.apiEndpoint?.baseUrl ?? '')
    setModel(account?.apiEndpoint?.model ?? '')
    setSmallFastModel(account?.apiEndpoint?.smallFastModel ?? '')
    setAuthToken('')
    setSaving(false)
    setError(null)
  })
  useLayoutEffect(() => {
    if (open) {
      seed()
    }
  }, [open])

  const preset = CLAUDE_API_ENDPOINT_PRESETS.find((entry) => entry.baseUrl === baseUrl.trim())
  const canSave =
    !saving &&
    Boolean(label.trim() && baseUrl.trim() && model.trim()) &&
    (editing || Boolean(authToken.trim()))

  const save = async (): Promise<void> => {
    if (!canSave) {
      return
    }
    setSaving(true)
    setError(null)
    try {
      const state = await window.api.claudeAccounts.saveApiEndpoint({
        endpoint: { label, baseUrl, authToken, model, smallFastModel },
        accountId: account?.id
      })
      if (!mountedRef.current) {
        return
      }
      setAuthToken('')
      onSaved(state)
      onOpenChange(false)
    } catch (saveError) {
      if (mountedRef.current) {
        setError(
          saveError instanceof Error
            ? saveError.message
            : translate('accounts.claude.apiEndpoint.saveFailed', 'Could not save the endpoint.')
        )
      }
    } finally {
      if (mountedRef.current) {
        setSaving(false)
      }
    }
  }

  const field = (
    id: string,
    title: string,
    value: string,
    onChange: (value: string) => void,
    options: { placeholder?: string; type?: string; list?: string } = {}
  ): React.JSX.Element => (
    <div className="space-y-2">
      <Label htmlFor={id} className="text-xs">
        {title}
      </Label>
      <Input
        id={id}
        type={options.type}
        list={options.list}
        placeholder={options.placeholder}
        value={value}
        onChange={(event) => {
          onChange(event.target.value)
          setError(null)
        }}
        disabled={saving}
        aria-invalid={error !== null}
        aria-describedby={error !== null ? errorId : undefined}
      />
    </div>
  )

  return (
    <Dialog open={open} onOpenChange={(next) => !saving && onOpenChange(next)}>
      <DialogContent
        className="sm:max-w-lg"
        onKeyDown={(event) => {
          if (event.target instanceof HTMLInputElement && event.key === 'Enter' && canSave) {
            event.preventDefault()
            void save()
          }
        }}
      >
        <DialogHeader className="gap-3">
          <DialogTitle className="leading-tight">
            {editing
              ? translate('accounts.claude.apiEndpoint.editTitle', 'Edit API endpoint')
              : translate('accounts.claude.apiEndpoint.addTitle', 'Add API endpoint')}
          </DialogTitle>
          <DialogDescription>
            {translate(
              'accounts.claude.apiEndpoint.description',
              'Claude Code sends this account’s requests to an Anthropic-compatible endpoint with your token.'
            )}
          </DialogDescription>
        </DialogHeader>
        {editing ? null : (
          <div className="flex flex-wrap items-center gap-1.5">
            {CLAUDE_API_ENDPOINT_PRESETS.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                variant="outline"
                size="xs"
                disabled={saving}
                onClick={() => {
                  setLabel(entry.label)
                  setBaseUrl(entry.baseUrl)
                  setModel(entry.model)
                  setSmallFastModel(entry.smallFastModel)
                  setError(null)
                }}
              >
                {entry.label}
              </Button>
            ))}
          </div>
        )}
        <div className="space-y-3">
          {field(labelId, translate('accounts.claude.apiEndpoint.name', 'Name'), label, setLabel)}
          {field(
            baseUrlId,
            translate('accounts.claude.apiEndpoint.baseUrl', 'Base URL'),
            baseUrl,
            setBaseUrl,
            { placeholder: 'https://api.example.com' }
          )}
          {field(
            tokenId,
            translate('accounts.claude.apiEndpoint.token', 'Token'),
            authToken,
            setAuthToken,
            {
              type: 'password',
              placeholder: editing
                ? translate('accounts.claude.apiEndpoint.tokenKeep', 'Leave blank to keep it')
                : undefined
            }
          )}
          {field(
            modelId,
            translate('accounts.claude.apiEndpoint.model', 'Model'),
            model,
            setModel,
            { list: preset ? modelListId : undefined }
          )}
          {field(
            smallFastModelId,
            translate('accounts.claude.apiEndpoint.smallFastModel', 'Background model'),
            smallFastModel,
            setSmallFastModel,
            {
              list: preset ? modelListId : undefined,
              placeholder: translate('accounts.claude.apiEndpoint.sameAsModel', 'Same as Model')
            }
          )}
          {preset ? (
            <datalist id={modelListId}>
              {[preset.model, ...preset.otherModels].map((name) => (
                <option key={name} value={name} />
              ))}
            </datalist>
          ) : null}
          {error ? (
            <p id={errorId} role="alert" className="text-xs text-destructive">
              {error}
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={saving}>
            {translate('auto.components.settings.AccountsPane.dbb9626ed1', 'Cancel')}
          </Button>
          <Button onClick={() => void save()} disabled={!canSave} className="gap-1.5">
            {saving ? <LoaderCircle className="size-3 animate-spin" /> : null}
            {translate('accounts.claude.apiEndpoint.save', 'Save')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Opens the dialog to add an endpoint account, or to edit `account`. */
export function ClaudeApiEndpointButton({
  account,
  disabled,
  onSaved,
  variant,
  className,
  children
}: {
  account?: ClaudeManagedAccountSummary
  disabled: boolean
  onSaved: (state: ClaudeRateLimitAccountsState) => void
  variant: 'outline' | 'ghost'
  className?: string
  children: React.ReactNode
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Button
        variant={variant}
        size="xs"
        onClick={(event) => {
          event.stopPropagation()
          setOpen(true)
        }}
        disabled={disabled}
        className={className}
      >
        {children}
      </Button>
      <ClaudeApiEndpointDialog
        open={open}
        onOpenChange={setOpen}
        account={account}
        onSaved={onSaved}
      />
    </>
  )
}

export function AddClaudeApiEndpointButton(props: {
  disabled: boolean
  onSaved: (state: ClaudeRateLimitAccountsState) => void
}): React.JSX.Element {
  return (
    <ClaudeApiEndpointButton variant="outline" className="gap-1.5" {...props}>
      <Plus className="size-3" />
      {translate('accounts.claude.apiEndpoint.add', 'Add API Endpoint')}
    </ClaudeApiEndpointButton>
  )
}

export function EditClaudeApiEndpointButton(props: {
  account: ClaudeManagedAccountSummary
  disabled: boolean
  onSaved: (state: ClaudeRateLimitAccountsState) => void
}): React.JSX.Element {
  return (
    <ClaudeApiEndpointButton
      variant="ghost"
      className="h-6 px-2 text-muted-foreground hover:text-foreground"
      {...props}
    >
      <Pencil className="size-3" />
      {translate('accounts.claude.apiEndpoint.edit', 'Edit')}
    </ClaudeApiEndpointButton>
  )
}
