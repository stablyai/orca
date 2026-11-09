import { ExternalLink } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { cloudSecretsErrorCopy } from '../settings/cloud-secrets/cloud-secrets-copy'
import { SecretValueInput } from '../settings/cloud-secrets/SecretValueInput'
import type { CloudAgentSetupFailure, CloudAgentSetupOption } from './cloud-agent-setup-choices'

export type CloudAgentSetupDraft = {
  provider: 'anthropic' | 'openai'
  key: string
  model: string
  codexModel: string
  baseUrl: string
}

export const EMPTY_DRAFT: CloudAgentSetupDraft = {
  provider: 'anthropic',
  key: '',
  model: '',
  codexModel: '',
  baseUrl: ''
}

const KEY_PAGES = {
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gateway: 'https://vercel.com/d?to=%2F%5Bteam%5D%2F%7E%2Fai%2Fapi-keys'
} as const

function GetKeyLink({ url }: { url: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <Button
      type="button"
      variant="link"
      size="inline"
      onClick={() => void window.api.shell.openUrl(url).catch(() => undefined)}
    >
      {t('cloudAgentSetup.getKey', 'Get a key')}
      <ExternalLink />
    </Button>
  )
}

function Field({
  id,
  label,
  helpId,
  help,
  error,
  link,
  children
}: {
  id: string
  label: string
  helpId?: string
  help?: string
  error?: string | null
  link?: React.ReactNode
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="flex min-h-4 items-center justify-between gap-2">
        <Label htmlFor={id} variant="settings">
          {label}
        </Label>
        {link}
      </div>
      {children}
      {error ? (
        <p id={helpId} role="alert" className="text-2xs text-destructive">
          {error}
        </p>
      ) : help ? (
        <p id={helpId} className="text-2xs text-muted-foreground">
          {help}
        </p>
      ) : null}
    </div>
  )
}

/** The inputs for one way in. Typed keys live only in the draft until they are sent. */
export function CloudAgentSetupFields({
  option,
  formId,
  draft,
  onDraft,
  failure,
  canShare,
  share,
  onShare
}: {
  option: Exclude<CloudAgentSetupOption, 'sign-in'>
  formId: string
  draft: CloudAgentSetupDraft
  onDraft: (patch: Partial<CloudAgentSetupDraft>) => void
  failure: CloudAgentSetupFailure | null
  canShare: boolean
  share: boolean
  onShare: (share: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const errorFor = (field: string): string | null =>
    failure?.field === field ? cloudSecretsErrorCopy(failure.error, t) : null
  const ids = (field: string): { id: string; helpId: string } => ({
    id: `${formId}-${field}`,
    helpId: `${formId}-${field}-help`
  })
  const textInput = (
    field: 'model' | 'codexModel' | 'baseUrl',
    placeholder: string
  ): React.JSX.Element => (
    <Input
      id={ids(field).id}
      variant="code"
      value={draft[field]}
      onChange={(event) => onDraft({ [field]: event.target.value })}
      placeholder={placeholder}
      aria-invalid={errorFor(field) !== null || undefined}
      aria-describedby={ids(field).helpId}
      spellCheck={false}
      autoComplete="off"
      className="h-8"
    />
  )
  const keyInput = (placeholder?: string): React.JSX.Element => (
    <SecretValueInput
      id={ids('key').id}
      value={draft.key}
      onChange={(key) => onDraft({ key })}
      invalid={errorFor('key') !== null || errorFor('token') !== null}
      describedBy={ids('key').helpId}
      placeholder={placeholder}
    />
  )
  const keyHelp = t('cloudAgentSetup.keyHelp', 'Hidden once saved.')

  return (
    <div className="space-y-3">
      {option === 'api-key' ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,10rem)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-provider`} variant="settings">
              {t('cloudAgentSetup.provider', 'Provider')}
            </Label>
            <Select
              value={draft.provider}
              onValueChange={(next) =>
                onDraft({ provider: next === 'openai' ? 'openai' : 'anthropic' })
              }
            >
              <SelectTrigger id={`${formId}-provider`} size="sm" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="anthropic">Anthropic</SelectItem>
                <SelectItem value="openai">OpenAI</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <Field
            {...ids('key')}
            label={
              draft.provider === 'anthropic'
                ? t('cloudAgentSetup.anthropicKey', 'Anthropic API key')
                : t('cloudAgentSetup.openaiKey', 'OpenAI API key')
            }
            link={<GetKeyLink url={KEY_PAGES[draft.provider]} />}
            help={keyHelp}
            error={errorFor('key')}
          >
            {keyInput(draft.provider === 'anthropic' ? 'sk-ant-api03-…' : 'sk-proj-…')}
          </Field>
        </div>
      ) : null}

      {option === 'gateway' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              {...ids('key')}
              label={t('cloudAgentSetup.gatewayKey', 'AI Gateway API key')}
              link={<GetKeyLink url={KEY_PAGES.gateway} />}
              help={keyHelp}
              error={errorFor('key')}
            >
              {keyInput('vck_…')}
            </Field>
          </div>
          <Field
            {...ids('model')}
            label={t('cloudAgentSetup.claudeModel', 'Claude Code model (optional)')}
            help={t(
              'cloudAgentSetup.gatewayModelHint',
              'Free gateway accounts can’t use anthropic/* models; try moonshotai/kimi-k2.'
            )}
            error={errorFor('model')}
          >
            {textInput('model', '')}
          </Field>
          <Field
            {...ids('codexModel')}
            label={t('cloudAgentSetup.codexModel', 'Codex model (optional)')}
            help={t(
              'cloudAgentSetup.gatewayCodexHint',
              'A gateway model id, such as openai/gpt-5.'
            )}
            error={errorFor('codexModel')}
          >
            {textInput('codexModel', '')}
          </Field>
        </div>
      ) : null}

      {option === 'custom' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="sm:col-span-2">
            <Field
              {...ids('baseUrl')}
              label={t('cloudAgentSetup.baseUrl', 'Base URL')}
              help={t(
                'cloudAgentSetup.baseUrlHelp',
                'An Anthropic-compatible endpoint on a public https host.'
              )}
              error={errorFor('baseUrl')}
            >
              {textInput('baseUrl', 'https://api.example.com/anthropic')}
            </Field>
          </div>
          <Field
            {...ids('key')}
            label={t('cloudAgentSetup.token', 'Auth token')}
            help={keyHelp}
            error={errorFor('token')}
          >
            {keyInput()}
          </Field>
          <Field
            {...ids('model')}
            label={t('cloudAgentSetup.modelOptional', 'Model (optional)')}
            help={t('cloudAgentSetup.modelHelp', 'Leave empty for the provider’s default.')}
            error={errorFor('model')}
          >
            {textInput('model', '')}
          </Field>
        </div>
      ) : null}

      {canShare ? (
        <div className="space-y-0.5">
          <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
            <Checkbox
              checked={share}
              onCheckedChange={(checked) => onShare(checked === true)}
              aria-describedby={`${formId}-share-help`}
            />
            {t('cloudAgentSetup.share', 'Share with my team')}
          </label>
          <p id={`${formId}-share-help`} className="pl-6 text-2xs text-muted-foreground">
            {t('cloudAgentSetup.shareDetail', 'Every teammate’s cloud agents use it.')}
          </p>
        </div>
      ) : null}
    </div>
  )
}
