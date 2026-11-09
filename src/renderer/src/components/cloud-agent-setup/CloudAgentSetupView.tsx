import { useId, useState } from 'react'
import { CircleCheck, Loader2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { HOST_AGENT_SIGN_IN_AGENT_NAME as AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import { Button } from '../ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../ui/tabs'
import { cloudSecretsErrorCopy } from '../settings/cloud-secrets/cloud-secrets-copy'
import {
  CLOUD_SETUP_AGENTS,
  type CloudAgentCredentialSource,
  type CloudAgentReadiness,
  type CloudSetupAgent
} from './cloud-agent-readiness'
import type {
  CloudAgentSetupChoice,
  CloudAgentSetupFailure,
  CloudAgentSetupOption,
  CloudAgentSetupScope
} from './cloud-agent-setup-choices'
import {
  CloudAgentSetupFields,
  EMPTY_DRAFT,
  type CloudAgentSetupDraft
} from './CloudAgentSetupFields'

export type { CloudAgentSetupFailure, CloudAgentSetupOption, CloudAgentSetupScope }
export type CloudAgentSetupSaved = { agents: CloudSetupAgent[]; scope: CloudAgentSetupScope }
type KeyOption = Exclude<CloudAgentSetupOption, 'sign-in'>

const KEY_OPTIONS: readonly KeyOption[] = ['api-key', 'gateway', 'custom']

/** "Your team provides Claude and Codex access · …": one clause per source, agents grouped. */
export function cloudAgentReadinessSummary(readiness: CloudAgentReadiness, t: Translate): string {
  const sources: CloudAgentCredentialSource[] = ['desktop-key', 'team', 'cloud-secret']
  return sources
    .flatMap((source) => {
      const agents = CLOUD_SETUP_AGENTS.filter((agent) => readiness[agent] === source)
      if (agents.length === 0) {
        return []
      }
      const agent =
        agents.length > 1
          ? t('cloudAgentSetup.source.both', 'Claude and Codex')
          : AGENT_NAME[agents[0]]
      switch (source) {
        case 'desktop-key':
          return [
            t('cloudAgentSetup.source.desktopKey', '{{agent}} uses your desktop API key', { agent })
          ]
        case 'team':
          return [
            t('cloudAgentSetup.source.team', 'Your team provides {{agent}} access', { agent })
          ]
        case 'cloud-secret':
          return [
            t('cloudAgentSetup.source.cloudSecret', '{{agent}} uses your cloud secret', { agent })
          ]
      }
    })
    .join(' · ')
}

/** "Claude key saved · shared with your team". Says stored, not verified: nothing tested the key yet. */
export function cloudAgentSavedSummary(saved: CloudAgentSetupSaved, t: Translate): string {
  const agent =
    saved.agents.length > 1
      ? t('cloudAgentSetup.source.both', 'Claude and Codex')
      : AGENT_NAME[saved.agents[0]]
  return saved.scope === 'org'
    ? t('cloudAgentSetup.saved.team', '{{agent}} key saved · shared with your team', { agent })
    : t('cloudAgentSetup.saved.personal', '{{agent}} key saved · personal', { agent })
}

function agentsFor(choice: CloudAgentSetupChoice): CloudSetupAgent[] {
  if (choice.kind === 'api-key') {
    return [choice.provider === 'anthropic' ? 'claude' : 'codex']
  }
  return choice.kind === 'gateway' ? ['claude', 'codex'] : ['claude']
}

function choiceFor(option: KeyOption, draft: CloudAgentSetupDraft): CloudAgentSetupChoice {
  switch (option) {
    case 'api-key':
      return { kind: 'api-key', provider: draft.provider, key: draft.key }
    case 'gateway':
      return { kind: 'gateway', key: draft.key, model: draft.model, codexModel: draft.codexModel }
    case 'custom':
      return { kind: 'custom', baseUrl: draft.baseUrl, token: draft.key, model: draft.model }
  }
}

export type CloudAgentSetupViewProps = {
  /** Shown above the choices in the dialog: what already works. */
  readiness: CloudAgentReadiness | null
  canShare: boolean
  /** The dialog also offers subscription sign-in, which there is only an explanation. */
  includeSignIn: boolean
  onSave: (
    choice: CloudAgentSetupChoice,
    scope: CloudAgentSetupScope
  ) => Promise<CloudAgentSetupFailure | null>
  onSaved: (saved: CloudAgentSetupSaved) => void
  onCancel: () => void
  /** Build sheet: a refused subscription token points back at in-VM sign-in. */
  onSignInInstead?: () => void
  /** Fixtures only. */
  initialOption?: CloudAgentSetupOption
  initialFailure?: CloudAgentSetupFailure | null
}

/** The ways Claude Code or Codex can get access in Orca Cloud with a key, plus sign-in in the dialog. */
export function CloudAgentSetupView({
  readiness,
  canShare,
  includeSignIn,
  onSave,
  onSaved,
  onCancel,
  onSignInInstead,
  initialOption,
  initialFailure = null
}: CloudAgentSetupViewProps): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const options: readonly CloudAgentSetupOption[] = includeSignIn
    ? ['sign-in', ...KEY_OPTIONS]
    : KEY_OPTIONS
  const [option, setOption] = useState<CloudAgentSetupOption>(initialOption ?? options[0])
  const [draft, setDraft] = useState<CloudAgentSetupDraft>(EMPTY_DRAFT)
  const [share, setShare] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<CloudAgentSetupFailure | null>(initialFailure)
  const summary = readiness ? cloudAgentReadinessSummary(readiness, t) : ''

  const labels: Record<CloudAgentSetupOption, { tab: string; detail: string }> = {
    'sign-in': {
      tab: t('cloudAgentSetup.option.signIn', 'Subscription'),
      detail: t(
        'cloudAgentSetup.option.signInDialog',
        'Claude Pro or Max, or ChatGPT: start Claude or Codex in a cloud workspace and sign in when it asks. The sign-in stays in that VM.'
      )
    },
    'api-key': {
      tab: t('cloudAgentSetup.option.apiKey', 'API key'),
      detail: t(
        'cloudAgentSetup.option.apiKeyDetail',
        'An Anthropic or OpenAI key, billed by usage.'
      )
    },
    gateway: {
      tab: t('cloudAgentSetup.option.gateway', 'AI Gateway'),
      detail: t(
        'cloudAgentSetup.option.gatewayDetail',
        'One Vercel AI Gateway key runs both Claude Code and Codex.'
      )
    },
    custom: {
      tab: t('cloudAgentSetup.option.custom', 'Custom provider'),
      detail: t(
        'cloudAgentSetup.option.customDetail',
        'Any Anthropic-compatible endpoint, for Claude Code.'
      )
    }
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (option === 'sign-in' || saving) {
      return
    }
    const choice = choiceFor(option, draft)
    const scope: CloudAgentSetupScope = canShare && share ? 'org' : 'personal'
    setSaving(true)
    setFailure(null)
    const result = await onSave(choice, scope)
    setSaving(false)
    if (result) {
      setFailure(result)
      return
    }
    setDraft(EMPTY_DRAFT)
    onSaved({ agents: agentsFor(choice), scope })
  }

  const canSubmit =
    option !== 'sign-in' &&
    draft.key.trim() !== '' &&
    (option !== 'custom' || draft.baseUrl.trim() !== '')
  // Field problems sit under their field; only ones without a field land in the footer.
  const footerError =
    failure && failure.field === undefined ? cloudSecretsErrorCopy(failure.error, t) : null

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !saving) {
          event.stopPropagation()
          onCancel()
        }
      }}
      className="space-y-3"
      aria-label={t('cloudAgentSetup.title', 'Add an agent')}
    >
      {summary ? <p className="text-xs leading-5 text-muted-foreground">{summary}</p> : null}
      <Tabs
        value={option}
        onValueChange={(next) => {
          const match = options.find((entry) => entry === next)
          if (match) {
            setOption(match)
            setDraft(EMPTY_DRAFT)
            setFailure(null)
          }
        }}
      >
        <TabsList size="sm">
          {options.map((entry) => (
            <TabsTrigger key={entry} value={entry}>
              {labels[entry].tab}
            </TabsTrigger>
          ))}
        </TabsList>
        {options.map((entry) => (
          <TabsContent key={entry} value={entry}>
            <div className="space-y-3 pt-1">
              <p className="text-xs leading-5 text-muted-foreground">{labels[entry].detail}</p>
              {entry === 'sign-in' ? null : (
                <CloudAgentSetupFields
                  option={entry}
                  formId={formId}
                  draft={draft}
                  onDraft={(patch) => {
                    setDraft((current) => ({ ...current, ...patch }))
                    setFailure(null)
                  }}
                  failure={failure}
                  canShare={canShare}
                  share={share}
                  onShare={setShare}
                />
              )}
              {entry === 'api-key' &&
              failure?.error === 'subscription_token_refused' &&
              (includeSignIn || onSignInInstead) ? (
                <Button
                  type="button"
                  variant="link"
                  size="inline"
                  onClick={() => (includeSignIn ? setOption('sign-in') : onSignInInstead?.())}
                >
                  {t('cloudSecrets.editor.signInInstead', 'Sign in instead')}
                </Button>
              ) : null}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <div className="flex items-center justify-between gap-3">
        <p role="alert" className="min-h-4 text-xs text-destructive">
          {footerError}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
            {option === 'sign-in'
              ? t('cloudAgentSetup.close', 'Close')
              : t('cloudSecrets.cancel', 'Cancel')}
          </Button>
          {option === 'sign-in' ? null : (
            <Button type="submit" size="sm" disabled={saving || !canSubmit}>
              {saving ? <Loader2 className="animate-spin" /> : null}
              {t('cloudAgentSetup.save', 'Save')}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}

/** The dialog's confirmation after a save. */
export function CloudAgentSetupSavedNotice({
  saved,
  onClose
}: {
  saved: CloudAgentSetupSaved
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="space-y-4">
      <div role="status" className="flex items-start gap-2.5">
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium">{cloudAgentSavedSummary(saved, t)}</p>
          <p className="text-xs leading-5 text-muted-foreground">
            {t(
              'cloudAgentSetup.saved.detail',
              'New terminals and agents in running cloud workspaces get it within seconds, no rebuild.'
            )}
          </p>
        </div>
      </div>
      <div className="flex justify-end">
        <Button size="sm" autoFocus onClick={onClose}>
          {t('cloudAgentSetup.done', 'Done')}
        </Button>
      </div>
    </div>
  )
}
