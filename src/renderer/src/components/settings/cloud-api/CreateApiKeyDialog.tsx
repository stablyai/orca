import { useId, useState } from 'react'
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/utils'
import {
  CLOUD_API_SCOPES,
  type CloudApiCreatedKey,
  type CloudApiResult,
  type CloudApiScope,
  type CreateCloudApiKeyInput
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { cloudApiErrorCopy, cloudApiScopeDescription } from './cloud-api-copy'
import { isAdminScope, scopesForPreset, type ScopePreset } from './cloud-api-format'
import { CloudApiErrorNotice, CopyValueButton, FormField, ScopeChip } from './cloud-api-parts'

const EXPIRY_OPTIONS = ['never', '7', '30', '90', '365'] as const
type Expiry = (typeof EXPIRY_OPTIONS)[number]

export type CreateApiKeyDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Scopes this viewer may grant (members cannot grant admin-only scopes). */
  availableScopes: readonly CloudApiScope[]
  onCreate: (input: CreateCloudApiKeyInput) => Promise<CloudApiResult<CloudApiCreatedKey>>
  /** Fixtures: open straight on the one-time secret. */
  initialCreated?: CloudApiCreatedKey
}

export function CreateApiKeyDialog(props: CreateApiKeyDialogProps): React.JSX.Element {
  const { open, onOpenChange } = props
  const [created, setCreated] = useState<CloudApiCreatedKey | null>(props.initialCreated ?? null)
  // Each open starts fresh; the secret must not survive a close and reopen.
  const handleOpenChange = (next: boolean): void => {
    if (!next) {
      setCreated(null)
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="sm:max-w-[520px]"
        // While the secret is on screen, a stray click outside must not throw it away.
        onInteractOutside={created ? (event) => event.preventDefault() : undefined}
      >
        {created ? (
          <SecretStep created={created} onDone={() => handleOpenChange(false)} />
        ) : (
          <FormStep {...props} onCreated={setCreated} onCancel={() => handleOpenChange(false)} />
        )}
      </DialogContent>
    </Dialog>
  )
}

function FormStep({
  availableScopes,
  onCreate,
  onCreated,
  onCancel
}: CreateApiKeyDialogProps & {
  onCreated: (created: CloudApiCreatedKey) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const [name, setName] = useState('')
  const [preset, setPreset] = useState<ScopePreset>('read')
  const [custom, setCustom] = useState<Set<CloudApiScope>>(
    () => new Set(scopesForPreset('read', availableScopes))
  )
  const [expiry, setExpiry] = useState<Expiry>('90')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nameTouched, setNameTouched] = useState(false)

  const scopes = preset === 'custom' ? [...custom] : scopesForPreset(preset, availableScopes)
  const nameMissing = name.trim().length === 0
  const canSubmit = !nameMissing && scopes.length > 0 && !submitting
  const restricted = CLOUD_API_SCOPES.filter((scope) => !availableScopes.includes(scope))

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setNameTouched(true)
    if (!canSubmit) {
      return
    }
    setSubmitting(true)
    setError(null)
    const result = await onCreate({
      name: name.trim(),
      // Keep the canonical order so lists read the same everywhere.
      scopes: CLOUD_API_SCOPES.filter((scope) => scopes.includes(scope)),
      ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) })
    })
    setSubmitting(false)
    if (result.ok) {
      onCreated(result.data)
    } else {
      setError(cloudApiErrorCopy(result.error, t, result))
    }
  }

  const toggle = (scope: CloudApiScope, on: boolean): void => {
    setCustom((current) => {
      const next = new Set(current)
      if (on) {
        next.add(scope)
      } else {
        next.delete(scope)
      }
      return next
    })
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="grid gap-5" noValidate>
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.settings.cloudApi.create.title', 'Create API key')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.settings.cloudApi.create.description',
            'Keys act as you inside your Orca Cloud account. Give each script or service its own key so you can revoke it alone.'
          )}
        </DialogDescription>
      </DialogHeader>

      <FormField
        id={`${ids}-name`}
        label={t('auto.components.settings.cloudApi.create.name', 'Name')}
        error={
          nameTouched && nameMissing
            ? t('auto.components.settings.cloudApi.create.nameRequired', 'Give the key a name.')
            : null
        }
        hint={t(
          'auto.components.settings.cloudApi.create.nameHint',
          'Shown in the key list and the audit log.'
        )}
      >
        <Input
          id={`${ids}-name`}
          autoFocus
          value={name}
          maxLength={100}
          placeholder={t(
            'auto.components.settings.cloudApi.create.namePlaceholder',
            'e.g. GitHub Actions deploy'
          )}
          aria-invalid={nameTouched && nameMissing}
          aria-describedby={nameTouched && nameMissing ? `${ids}-name-error` : `${ids}-name-hint`}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => setNameTouched(true)}
        />
      </FormField>

      <div className="grid gap-2">
        <p id={`${ids}-perm`} className="text-xs font-medium">
          {t('auto.components.settings.cloudApi.create.permissions', 'Permissions')}
        </p>
        <SettingsSegmentedControl<ScopePreset>
          value={preset}
          onChange={(next) => {
            if (next === 'custom' && preset !== 'custom') {
              setCustom(new Set(scopesForPreset(preset, availableScopes)))
            }
            setPreset(next)
          }}
          ariaLabelledBy={`${ids}-perm`}
          size="sm"
          equalWidth
          options={[
            {
              value: 'read',
              label: t('auto.components.settings.cloudApi.create.readOnly', 'Read only')
            },
            {
              value: 'full',
              label: t('auto.components.settings.cloudApi.create.full', 'Full access')
            },
            {
              value: 'custom',
              label: t('auto.components.settings.cloudApi.create.custom', 'Custom')
            }
          ]}
        />
        {preset === 'custom' ? (
          <fieldset className="grid gap-0.5 rounded-lg border border-border/70 p-1.5">
            <legend className="sr-only">
              {t('auto.components.settings.cloudApi.create.scopesLegend', 'Scopes')}
            </legend>
            {CLOUD_API_SCOPES.map((scope) => {
              const locked = !availableScopes.includes(scope)
              const id = `${ids}-scope-${scope}`
              return (
                <label
                  key={scope}
                  htmlFor={id}
                  className={cn(
                    'flex items-start gap-2.5 rounded-md px-2 py-1.5',
                    locked ? 'cursor-not-allowed' : 'cursor-pointer hover:bg-accent/50'
                  )}
                >
                  <Checkbox
                    id={id}
                    className="mt-0.5"
                    checked={!locked && custom.has(scope)}
                    disabled={locked}
                    aria-describedby={locked ? `${ids}-locked` : undefined}
                    onCheckedChange={(checked) => toggle(scope, checked === true)}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn('block font-mono text-xs', locked && 'text-muted-foreground')}
                    >
                      {scope}
                    </span>
                    <span className="block text-xs text-muted-foreground">
                      {cloudApiScopeDescription(scope, t)}
                      {isAdminScope(scope) && locked
                        ? ` · ${t('auto.components.settings.cloudApi.create.adminOnly', 'Admins only')}`
                        : null}
                    </span>
                  </span>
                </label>
              )
            })}
          </fieldset>
        ) : (
          <div className="flex flex-wrap gap-1" aria-live="polite">
            {scopes.map((scope) => (
              <ScopeChip key={scope} scope={scope} />
            ))}
          </div>
        )}
        {restricted.length > 0 ? (
          <p
            id={`${ids}-locked`}
            className="flex items-start gap-1.5 text-xs text-muted-foreground"
          >
            <ShieldAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {t(
              'auto.components.settings.cloudApi.create.restricted',
              'Only org owners and admins can grant {{value0}}. Ask one of them if a script needs it.',
              { value0: restricted.join(', ') }
            )}
          </p>
        ) : null}
        {preset === 'custom' && scopes.length === 0 ? (
          <p className="text-xs text-destructive">
            {t(
              'auto.components.settings.cloudApi.create.scopeRequired',
              'Pick at least one scope.'
            )}
          </p>
        ) : null}
      </div>

      <FormField
        id={`${ids}-expiry`}
        label={t('auto.components.settings.cloudApi.create.expiry', 'Expires')}
      >
        <Select value={expiry} onValueChange={(next) => setExpiry(next as Expiry)}>
          <SelectTrigger id={`${ids}-expiry`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent position="popper">
            <SelectItem value="never">
              {t('auto.components.settings.cloudApi.create.expiryNever', 'Never')}
            </SelectItem>
            {(['7', '30', '90'] as const).map((days) => (
              <SelectItem key={days} value={days}>
                {t('auto.components.settings.cloudApi.create.expiryDays', 'In {{value0}} days', {
                  value0: days
                })}
              </SelectItem>
            ))}
            <SelectItem value="365">
              {t('auto.components.settings.cloudApi.create.expiryYear', 'In 1 year')}
            </SelectItem>
          </SelectContent>
        </Select>
      </FormField>

      {error ? <CloudApiErrorNotice message={error} /> : null}

      <DialogFooter>
        <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={submitting}>
          {t('auto.components.settings.cloudApi.cancel', 'Cancel')}
        </Button>
        <Button type="submit" size="sm" disabled={!canSubmit}>
          {submitting ? (
            <Loader2 className="animate-spin motion-reduce:animate-none" />
          ) : (
            <KeyRound />
          )}
          {t('auto.components.settings.cloudApi.create.submit', 'Create key')}
        </Button>
      </DialogFooter>
    </form>
  )
}

function SecretStep({
  created,
  onDone
}: {
  created: CloudApiCreatedKey
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const ids = useId()
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.settings.cloudApi.secret.title', 'Copy your new key')}
        </DialogTitle>
        <DialogDescription>
          {t(
            'auto.components.settings.cloudApi.secret.description',
            '“{{value0}}” is ready to use.',
            {
              value0: created.key.name
            }
          )}
        </DialogDescription>
      </DialogHeader>

      <div
        role="note"
        className="flex items-start gap-2.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2.5 text-xs leading-5 text-foreground"
      >
        <ShieldAlert
          className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
          aria-hidden
        />
        <p>
          <span className="font-medium">
            {t(
              'auto.components.settings.cloudApi.secret.onceTitle',
              'This is the only time Orca shows this key.'
            )}
          </span>{' '}
          {t(
            'auto.components.settings.cloudApi.secret.onceBody',
            'Store it in a password manager or your CI secrets now. If you lose it, revoke it and create a new one.'
          )}
        </p>
      </div>

      <div className="grid gap-1.5">
        <label htmlFor={`${ids}-secret`} className="text-xs font-medium">
          {t('auto.components.settings.cloudApi.secret.label', 'Secret key')}
        </label>
        <div className="flex items-center gap-2">
          <Input
            id={`${ids}-secret`}
            readOnly
            value={created.secret}
            spellCheck={false}
            className="font-mono text-xs"
            onClick={(event) => event.currentTarget.select()}
          />
          <CopyValueButton
            value={created.secret}
            variant="default"
            size="sm"
            label={t('auto.components.settings.cloudApi.secret.copyLabel', 'Copy secret key')}
            onCopied={() => setCopied(true)}
          />
        </div>
      </div>

      <DialogFooter>
        <Button type="button" size="sm" variant={copied ? 'default' : 'outline'} onClick={onDone}>
          {copied
            ? t('auto.components.settings.cloudApi.secret.done', 'Done')
            : t('auto.components.settings.cloudApi.secret.doneUncopied', 'I’ve saved it')}
        </Button>
      </DialogFooter>
    </div>
  )
}
