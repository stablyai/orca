import { CircleCheck } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { HOST_AGENT_SIGN_IN_AGENT_NAME as AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { Checkbox } from '../ui/checkbox'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
import { SecretValueInput } from '../settings/cloud-secrets/SecretValueInput'
import type { CloudSetupAgent } from './cloud-agent-readiness'
import type {
  CloudAgentSetupFailure,
  CloudAgentSetupOption,
  CloudAgentSetupScope
} from './cloud-agent-setup-choices'

export type CloudAgentSetupDraft = {
  provider: 'anthropic' | 'openai'
  key: string
  model: string
  baseUrl: string
}

export const EMPTY_DRAFT: CloudAgentSetupDraft = {
  provider: 'anthropic',
  key: '',
  model: '',
  baseUrl: ''
}

function Field({
  id,
  label,
  hint,
  children
}: {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <Label htmlFor={id} variant="settings">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-2xs text-muted-foreground">{hint}</p> : null}
    </div>
  )
}

/** The inputs for the chosen way in. Typed keys live only in the draft until they are sent. */
export function CloudAgentSetupFields({
  option,
  formId,
  errorId,
  draft,
  onDraft,
  failure,
  signInInVm,
  canShare,
  share,
  onShare
}: {
  option: CloudAgentSetupOption
  formId: string
  errorId: string
  draft: CloudAgentSetupDraft
  onDraft: (patch: Partial<CloudAgentSetupDraft>) => void
  failure: CloudAgentSetupFailure | null
  signInInVm: boolean
  canShare: boolean
  share: boolean
  onShare: (share: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const fieldError = (field: string): boolean =>
    failure !== null && (failure.field ?? 'key') === field
  return (
    <div className="space-y-3">
      {option === 'sign-in' ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {signInInVm
            ? t(
                'cloudAgentSetup.signIn.build',
                'Orca opens the provider’s sign-in page as soon as the VM is ready. The token stays in the VM; Orca never stores it.'
              )
            : t(
                'cloudAgentSetup.signIn.dialog',
                'Start Claude or Codex in any cloud workspace and sign in when it asks. The token stays in that VM; Orca never stores it.'
              )}
        </p>
      ) : null}

      {option === 'api-key' ? (
        <div className="grid gap-3 sm:grid-cols-[minmax(0,11rem)_minmax(0,1fr)]">
          <div className="space-y-1.5">
            <p id={`${formId}-provider`} className="text-xs text-muted-foreground">
              {t('cloudAgentSetup.provider', 'Provider')}
            </p>
            <RadioGroup
              layout="inline"
              value={draft.provider}
              onValueChange={(next) =>
                onDraft({ provider: next === 'openai' ? 'openai' : 'anthropic' })
              }
              aria-labelledby={`${formId}-provider`}
              className="h-8"
            >
              <RadioGroupItem value="anthropic" variant="pill">
                Anthropic
              </RadioGroupItem>
              <RadioGroupItem value="openai" variant="pill">
                OpenAI
              </RadioGroupItem>
            </RadioGroup>
          </div>
          <Field
            id={`${formId}-key`}
            label={
              draft.provider === 'anthropic'
                ? t('cloudAgentSetup.anthropicKey', 'Anthropic API key')
                : t('cloudAgentSetup.openaiKey', 'OpenAI API key')
            }
          >
            <SecretValueInput
              id={`${formId}-key`}
              value={draft.key}
              onChange={(key) => onDraft({ key })}
              autoFocus
              invalid={fieldError('key')}
              describedBy={errorId}
              placeholder={draft.provider === 'anthropic' ? 'sk-ant-api03-…' : 'sk-proj-…'}
            />
          </Field>
        </div>
      ) : null}

      {option === 'gateway' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${formId}-key`} label={t('cloudAgentSetup.gatewayKey', 'AI Gateway API key')}>
            <SecretValueInput
              id={`${formId}-key`}
              value={draft.key}
              onChange={(key) => onDraft({ key })}
              autoFocus
              invalid={fieldError('key')}
              describedBy={errorId}
            />
          </Field>
          <Field
            id={`${formId}-model`}
            label={t('cloudAgentSetup.modelOptional', 'Model (optional)')}
            hint={t('cloudAgentSetup.gatewayModelHint', 'For Claude Code. Codex picks its own.')}
          >
            <Input
              id={`${formId}-model`}
              variant="code"
              value={draft.model}
              onChange={(event) => onDraft({ model: event.target.value })}
              placeholder="anthropic/claude-sonnet-4.5"
              aria-invalid={fieldError('model') || undefined}
              spellCheck={false}
              autoComplete="off"
              className="h-8"
            />
          </Field>
        </div>
      ) : null}

      {option === 'custom' ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field id={`${formId}-url`} label={t('cloudAgentSetup.baseUrl', 'Base URL')}>
            <Input
              id={`${formId}-url`}
              variant="code"
              value={draft.baseUrl}
              autoFocus
              onChange={(event) => onDraft({ baseUrl: event.target.value })}
              placeholder="https://api.example.com/anthropic"
              aria-invalid={fieldError('baseUrl') || undefined}
              aria-describedby={errorId}
              spellCheck={false}
              autoComplete="off"
              className="h-8"
            />
          </Field>
          <Field id={`${formId}-key`} label={t('cloudAgentSetup.token', 'Auth token')}>
            <SecretValueInput
              id={`${formId}-key`}
              value={draft.key}
              onChange={(key) => onDraft({ key })}
              invalid={fieldError('token')}
              describedBy={errorId}
            />
          </Field>
          <Field
            id={`${formId}-model`}
            label={t('cloudAgentSetup.modelOptional', 'Model (optional)')}
          >
            <Input
              id={`${formId}-model`}
              variant="code"
              value={draft.model}
              onChange={(event) => onDraft({ model: event.target.value })}
              placeholder="moonshotai/kimi-k2"
              aria-invalid={fieldError('model') || undefined}
              spellCheck={false}
              autoComplete="off"
              className="h-8"
            />
          </Field>
        </div>
      ) : null}

      {option !== 'sign-in' && canShare ? (
        <label className="flex w-fit cursor-pointer items-center gap-2 text-xs">
          <Checkbox checked={share} onCheckedChange={(checked) => onShare(checked === true)} />
          {t('cloudAgentSetup.share', 'Share with my team')}
          <span className="text-muted-foreground">
            {t('cloudAgentSetup.shareDetail', '· every teammate’s agents use this key')}
          </span>
        </label>
      ) : null}
    </div>
  )
}

export function CloudAgentSetupSaved({
  saved,
  surface,
  onDone
}: {
  saved: { agents: CloudSetupAgent[]; scope: CloudAgentSetupScope }
  surface: 'build' | 'dialog'
  onDone: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div
      role="status"
      className={cn(
        'flex items-start gap-2.5 text-sm',
        surface === 'build' && 'rounded-lg border border-border bg-background/60 p-3'
      )}
    >
      <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="font-medium">
          {saved.agents.length > 1
            ? t('cloudAgentSetup.saved.both', 'Claude and Codex are set up')
            : t('cloudAgentSetup.saved.one', '{{agent}} is set up', {
                agent: AGENT_NAME[saved.agents[0]]
              })}
        </p>
        <p className="text-xs leading-5 text-muted-foreground">
          {saved.scope === 'org'
            ? t(
                'cloudAgentSetup.saved.team',
                'Shared with your team. New terminals and agents in every teammate’s cloud workspaces get it within seconds, with no rebuild. The key is hidden from now on.'
              )
            : t(
                'cloudAgentSetup.saved.personal',
                'Saved as a personal cloud secret. New terminals and agents in your cloud workspaces get it within seconds, with no rebuild. The key is hidden from now on.'
              )}
        </p>
      </div>
      <Button variant="ghost" size="xs" onClick={onDone}>
        {t('cloudAgentSetup.done', 'Done')}
      </Button>
    </div>
  )
}
