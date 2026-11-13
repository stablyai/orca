import React from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { SecretValueInput } from '@/components/settings/cloud-secrets/SecretValueInput'
import {
  cloudSecretScopeLabel,
  cloudSecretsErrorCopy
} from '@/components/settings/cloud-secrets/cloud-secrets-copy'
import type {
  CloudSecretScope,
  CloudSecretsErrorCode
} from '../../../../../shared/cloud-secrets/cloud-secrets-wire'
import { parseScope, writableScopes } from '../../cloud-secrets-ask/cloud-secrets-ask-model'
import type { CloudPanelAddSecret, CloudPanelSectionsData } from './use-cloud-panel-sections'

/** A declared name nobody provides: Missing chip, then Add (members: Add mine) opens an inline field. */
export function CloudMissingSecretRow({
  name,
  data,
  expanded,
  onExpand,
  onCollapse,
  onAdd,
  autoFocus
}: {
  name: string
  data: CloudPanelSectionsData
  expanded: boolean
  onExpand: () => void
  onCollapse: () => void
  onAdd: CloudPanelAddSecret
  autoFocus: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const id = React.useId()
  const admin = data.effective.caller.canWrite.org
  // A teammate's Personal values don't reach someone else's shared workspace (or one we can't tell).
  const guest = data.withoutPersonal
  const scopes = writableScopes(data.effective.caller, {
    repo: data.repoKey !== null,
    shared: true
  }).filter((option) => !guest || option !== 'personal')
  const canAdd = scopes.length > 0
  const [value, setValue] = React.useState('')
  const [scope, setScope] = React.useState<CloudSecretScope>(scopes[0] ?? 'personal')
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<CloudSecretsErrorCode | null>(null)
  const addLabel =
    admin || guest
      ? t('agentHostPanel.env.add', 'Add')
      : t('agentHostPanel.env.addMine', 'Add mine')
  const save = async (): Promise<void> => {
    if (!value || saving) {
      return
    }
    setSaving(true)
    setError(null)
    const refusal = await onAdd(name, value, scope)
    setSaving(false)
    if (refusal) {
      setError(refusal)
      return
    }
    setValue('')
    onCollapse()
  }
  return (
    <li className="flex flex-col gap-2 py-2.5">
      <div className="flex min-w-0 items-center gap-2">
        <code className="truncate font-mono text-xs text-foreground">{name}</code>
        <span className="inline-flex shrink-0 items-center rounded-full border border-status-warning/40 bg-status-warning-background px-2 py-0.5 text-xs font-medium text-status-warning-text">
          {t('agentHostPanel.env.missing', 'Missing')}
        </span>
        {expanded ? null : !canAdd ? (
          <span className="ms-auto text-end text-xs text-muted-foreground">
            {/* SEC-5: the workspace's owner can't fill it with a Personal value either, so only
                owners and admins (Repository or Shared) can. */}
            {t('agentHostPanel.keys.askAdmin', 'Ask an owner or admin to add one.')}
          </span>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="xs"
            className="ms-auto"
            onClick={onExpand}
            aria-label={`${addLabel} · ${name}`}
          >
            {addLabel}
          </Button>
        )}
      </div>
      {expanded && canAdd ? (
        <div className="flex flex-col gap-2">
          <Label htmlFor={`${id}-value`} className="sr-only">
            {t('agentHostPanel.env.valueLabel', 'Value for {{name}}', { name })}
          </Label>
          <div className="flex items-start gap-2">
            <div
              className="min-w-0 flex-1"
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault()
                  void save()
                } else if (event.key === 'Escape') {
                  event.stopPropagation()
                  onCollapse()
                }
              }}
            >
              <SecretValueInput
                id={`${id}-value`}
                value={value}
                onChange={(next) => {
                  setValue(next)
                  setError(null)
                }}
                placeholder={t('agentHostPanel.env.valuePlaceholder', 'Value')}
                invalid={error !== null}
                disabled={saving}
                autoFocus={autoFocus}
                describedBy={error ? `${id}-error` : `${id}-help`}
              />
            </div>
            {scopes.length > 1 || scopes[0] !== 'personal' ? (
              <Select
                value={scope}
                onValueChange={(next) => setScope(parseScope(next))}
                disabled={saving}
              >
                <SelectTrigger
                  size="sm"
                  className="w-32 shrink-0"
                  aria-label={t('cloudSecretsAsk.scopeLabel', 'Scope for {{name}}', { name })}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((option) => (
                    <SelectItem key={option} value={option}>
                      {cloudSecretScopeLabel(option, t)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <span className="inline-flex h-8 shrink-0 items-center rounded-full border border-border px-2.5 text-xs text-muted-foreground">
                {cloudSecretScopeLabel('personal', t)}
              </span>
            )}
          </div>
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
              {error === 'org_admin_required'
                ? t(
                    'cloudSecretsAsk.memberRefused',
                    'Only owners and admins can save team or repository values. Choose Personal.'
                  )
                : cloudSecretsErrorCopy(error, t)}
            </p>
          ) : null}
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p id={`${id}-help`} className="min-w-0 flex-1 text-xs text-muted-foreground">
              {admin || guest
                ? t('cloudSecrets.editor.help', 'Write-only. You won’t see it again after saving.')
                : t(
                    'agentHostPanel.env.memberHelp',
                    'Saved to your personal Cloud secrets, so only your workspaces get it.'
                  )}
            </p>
            <div className="flex shrink-0 items-center gap-2">
              <Button
                type="button"
                variant="ghost"
                size="xs"
                onClick={onCollapse}
                disabled={saving}
              >
                {t('agentHostPanel.env.cancel', 'Cancel')}
              </Button>
              <Button
                type="button"
                size="xs"
                aria-disabled={!value || saving || undefined}
                aria-busy={saving || undefined}
                onClick={value && !saving ? () => void save() : undefined}
              >
                {saving ? <Loader2 aria-hidden className="motion-safe:animate-spin" /> : null}
                {t('agentHostPanel.env.save', 'Save')}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </li>
  )
}
