import { useId, useRef, useState } from 'react'
import { KeyRound, Loader2, ShieldAlert } from 'lucide-react'
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import {
  CLOUD_API_SCOPES,
  type CloudApiCreatedKey,
  type CloudApiResult,
  type CloudApiScope,
  type CreateCloudApiKeyInput
} from '../../../../../shared/cloud-api/cloud-api-types'
import { SettingsSegmentedControl } from '../form-controls/SettingsFormControls'
import { cloudApiErrorCopy, cloudApiScopeDescription } from './cloud-api-copy'
import { scopesForPreset, type ScopePreset } from './cloud-api-format'
import { CloudApiErrorNotice, FormField, ScopeChip } from './cloud-api-parts'
import { OneTimeSecret, OneTimeSecretDoneButton } from './OneTimeSecret'
import { ScopeMatrix } from './ScopeMatrix'

const EXPIRY_OPTIONS = ['never', '7', '30', '90', '365'] as const
type Expiry = (typeof EXPIRY_OPTIONS)[number]

export type CreateApiKeyDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Scopes this viewer may grant (members cannot grant admin-only scopes). */
  availableScopes: readonly CloudApiScope[]
  onCreate: (input: CreateCloudApiKeyInput) => Promise<CloudApiResult<CloudApiCreatedKey>>
  /** Where focus goes when the dialog closes (the trigger may have unmounted). */
  returnFocusTo?: () => HTMLElement | null
  /** Fixtures: open straight on the one-time secret. */
  initialCreated?: CloudApiCreatedKey
}

export function CreateApiKeyDialog(props: CreateApiKeyDialogProps): React.JSX.Element {
  const { open, onOpenChange } = props
  const [created, setCreated] = useState<CloudApiCreatedKey | null>(props.initialCreated ?? null)
  const [busy, setBusy] = useState(false)
  // Each open starts fresh; the secret must not survive a close and reopen. While a create is in
  // flight the dialog stays open, so its one-time secret always lands in front of the user.
  const handleOpenChange = (next: boolean): void => {
    if (!next && busy) {
      return
    }
    if (!next) {
      setCreated(null)
    }
    onOpenChange(next)
  }
  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        // Anchored near the top so switching to Custom grows the dialog downwards, not both ways.
        className="sm:top-[12vh] sm:max-w-[520px] sm:translate-y-0"
        // While the secret is on screen only the footer button may close it: no stray click,
        // Escape or × can throw it away.
        showCloseButton={!created}
        onInteractOutside={created ? (event) => event.preventDefault() : undefined}
        onEscapeKeyDown={created ? (event) => event.preventDefault() : undefined}
        onCloseAutoFocus={(event) => {
          const target = props.returnFocusTo?.()
          if (target) {
            event.preventDefault()
            target.focus()
          }
        }}
      >
        {created ? (
          <SecretStep created={created} onDone={() => handleOpenChange(false)} />
        ) : (
          <FormStep
            {...props}
            onBusyChange={setBusy}
            onCreated={setCreated}
            onCancel={() => handleOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function FormStep({
  availableScopes,
  onCreate,
  onCreated,
  onCancel,
  onBusyChange
}: CreateApiKeyDialogProps & {
  onBusyChange: (busy: boolean) => void
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
  const nameRef = useRef<HTMLInputElement>(null)

  const scopes = preset === 'custom' ? [...custom] : scopesForPreset(preset, availableScopes)
  const nameMissing = name.trim().length === 0
  const canSubmit = !nameMissing && scopes.length > 0 && !submitting
  const restricted = CLOUD_API_SCOPES.filter((scope) => !availableScopes.includes(scope))

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    setNameTouched(true)
    if (!canSubmit) {
      if (nameMissing) {
        nameRef.current?.focus()
      }
      return
    }
    setSubmitting(true)
    onBusyChange(true)
    setError(null)
    const result = await onCreate({
      name: name.trim(),
      // Keep the canonical order so lists read the same everywhere.
      scopes: CLOUD_API_SCOPES.filter((scope) => scopes.includes(scope)),
      ...(expiry === 'never' ? {} : { expiresInDays: Number(expiry) })
    })
    setSubmitting(false)
    onBusyChange(false)
    if (result.ok) {
      onCreated(result.data)
    } else {
      setError(cloudApiErrorCopy(result.error, t, result))
    }
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
            'A key acts as you on your team. Give each script or service its own key so you can revoke it alone.'
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
          ref={nameRef}
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
          <ScopeMatrix scopes={custom} available={availableScopes} onChange={setCustom} />
        ) : (
          <div className="flex flex-wrap items-center gap-1" aria-live="polite">
            <span className="mr-1 text-xs text-muted-foreground">
              {t('auto.components.settings.cloudApi.create.includes', 'Includes')}
            </span>
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
              'Only team owners and admins can grant access to: {{value0}}. Ask one of them if a script needs it.',
              {
                value0: restricted
                  .map((scope) => cloudApiScopeDescription(scope, t).toLowerCase())
                  .join(', ')
              }
            )}
          </p>
        ) : null}
        {preset === 'custom' && scopes.length === 0 ? (
          <p role="alert" className="text-xs text-destructive">
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
  const [copied, setCopied] = useState(false)
  return (
    <div className="grid gap-5">
      <DialogHeader>
        <DialogTitle>
          {t('auto.components.settings.cloudApi.secret.title', 'Copy your new key')}
        </DialogTitle>
        <DialogDescription>
          {created.key
            ? t(
                'auto.components.settings.cloudApi.secret.description',
                '“{{value0}}” is ready to use.',
                {
                  value0: created.key.name
                }
              )
            : t(
                'auto.components.settings.cloudApi.secret.descriptionUnnamed',
                'Your new key is ready to use.'
              )}
        </DialogDescription>
      </DialogHeader>
      <OneTimeSecret
        label={t('auto.components.settings.cloudApi.secret.label', 'Secret key')}
        value={created.secret}
        copyLabel={t('auto.components.settings.cloudApi.secret.copyLabel', 'Copy secret key')}
        warningTitle={t(
          'auto.components.settings.cloudApi.secret.onceTitle',
          'This is the only time Orca shows this key.'
        )}
        warningBody={t(
          'auto.components.settings.cloudApi.secret.onceBody',
          'Store it in a password manager or your CI secrets now. If you lose it, revoke it and create a new one.'
        )}
        onCopied={() => setCopied(true)}
      />
      <DialogFooter>
        <OneTimeSecretDoneButton copied={copied} onDone={onDone} />
      </DialogFooter>
    </div>
  )
}
