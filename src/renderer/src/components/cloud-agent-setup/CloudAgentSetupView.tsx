import { useId, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { HOST_AGENT_SIGN_IN_AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import { cn } from '@/lib/utils'
import { Button } from '../ui/button'
import { RadioGroup, RadioGroupItem } from '../ui/radio-group'
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
  CloudAgentSetupSaved,
  EMPTY_DRAFT,
  type CloudAgentSetupDraft
} from './CloudAgentSetupFields'

export type { CloudAgentSetupFailure, CloudAgentSetupOption, CloudAgentSetupScope }

export type CloudAgentSetupViewProps = {
  readiness: CloudAgentReadiness | null
  canShare: boolean
  surface: 'build' | 'dialog'
  onSave: (
    choice: CloudAgentSetupChoice,
    scope: CloudAgentSetupScope
  ) => Promise<CloudAgentSetupFailure | null>
  /** Build sheet only: sign-in happens in the VM through the checklist's sign-in row. */
  onSignIn?: () => void
  onLater: () => void
  /** Fixtures only. */
  initialOption?: CloudAgentSetupOption
  initialSaved?: { agents: CloudSetupAgent[]; scope: CloudAgentSetupScope } | null
  initialFailure?: CloudAgentSetupFailure | null
}

const AGENT_NAME = HOST_AGENT_SIGN_IN_AGENT_NAME

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
            t('cloudAgentSetup.source.desktopKey', '{{agent}}: your API key, used automatically', {
              agent
            })
          ]
        case 'team':
          return [
            t('cloudAgentSetup.source.team', 'Your team provides {{agent}} access', { agent })
          ]
        case 'cloud-secret':
          return [
            t('cloudAgentSetup.source.cloudSecret', '{{agent}}: your cloud secret', { agent })
          ]
      }
    })
    .join(' · ')
}

function agentsFor(choice: CloudAgentSetupChoice): CloudSetupAgent[] {
  if (choice.kind === 'api-key') {
    return [choice.provider === 'anthropic' ? 'claude' : 'codex']
  }
  return choice.kind === 'gateway' ? ['claude', 'codex'] : ['claude']
}

/** "Add an agent": the ways Claude Code or Codex can authenticate in Orca Cloud, best first. */
export function CloudAgentSetupView({
  readiness,
  canShare,
  surface,
  onSave,
  onSignIn,
  onLater,
  initialOption = 'sign-in',
  initialSaved = null,
  initialFailure = null
}: CloudAgentSetupViewProps): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const [option, setOption] = useState<CloudAgentSetupOption>(initialOption)
  const [draft, setDraft] = useState<CloudAgentSetupDraft>(EMPTY_DRAFT)
  const [share, setShare] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<CloudAgentSetupFailure | null>(initialFailure)
  const [saved, setSaved] = useState(initialSaved)
  const ready = readiness ? CLOUD_SETUP_AGENTS.filter((agent) => readiness[agent] !== null) : []

  const choose = (next: CloudAgentSetupOption): void => {
    setOption(next)
    setDraft(EMPTY_DRAFT)
    setFailure(null)
  }

  const choice = (): CloudAgentSetupChoice | null => {
    switch (option) {
      case 'api-key':
        return { kind: 'api-key', provider: draft.provider, key: draft.key }
      case 'gateway':
        return { kind: 'gateway', key: draft.key, model: draft.model }
      case 'custom':
        return { kind: 'custom', baseUrl: draft.baseUrl, token: draft.key, model: draft.model }
      case 'sign-in':
        return null
    }
  }

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault()
    if (option === 'sign-in') {
      onSignIn?.()
      return
    }
    const next = choice()
    if (!next || saving) {
      return
    }
    const scope: CloudAgentSetupScope = canShare && share ? 'org' : 'personal'
    setSaving(true)
    setFailure(null)
    const result = await onSave(next, scope)
    setSaving(false)
    if (result) {
      setFailure(result)
      return
    }
    setDraft(EMPTY_DRAFT)
    setSaved({ agents: agentsFor(next), scope })
  }

  if (saved) {
    return <CloudAgentSetupSaved saved={saved} surface={surface} onDone={onLater} />
  }

  const options: { value: CloudAgentSetupOption; title: string; detail: string }[] = [
    {
      value: 'sign-in',
      title: t('cloudAgentSetup.option.signIn', 'Sign in with your subscription'),
      detail: t(
        'cloudAgentSetup.option.signInDetail',
        'Claude Pro or Max, or ChatGPT. One click once the VM is up; the sign-in stays in the VM.'
      )
    },
    {
      value: 'api-key',
      title: t('cloudAgentSetup.option.apiKey', 'Paste an API key'),
      detail: t(
        'cloudAgentSetup.option.apiKeyDetail',
        'An Anthropic or OpenAI key, billed by usage.'
      )
    },
    {
      value: 'gateway',
      title: t('cloudAgentSetup.option.gateway', 'Vercel AI Gateway'),
      detail: t(
        'cloudAgentSetup.option.gatewayDetail',
        'One key runs both Claude Code and Codex, on any model the gateway offers.'
      )
    },
    {
      value: 'custom',
      title: t('cloudAgentSetup.option.custom', 'Custom provider'),
      detail: t(
        'cloudAgentSetup.option.customDetail',
        'Any Anthropic-compatible endpoint: a base URL, a token and a model.'
      )
    }
  ]

  const errorLine = failure ? cloudSecretsErrorCopy(failure.error, t) : null
  const errorId = `${formId}-error`

  return (
    <form
      onSubmit={(event) => void submit(event)}
      className={cn(
        'space-y-4',
        surface === 'build' && 'rounded-lg border border-border bg-background/60 p-4'
      )}
      aria-label={t('cloudAgentSetup.title', 'Add an agent')}
    >
      {/* The build sheet's checklist row carries the title. */}
      {surface === 'dialog' ? (
        <p className="text-xs leading-5 text-muted-foreground">
          {ready.length > 0 && readiness
            ? cloudAgentReadinessSummary(readiness, t)
            : t(
                'cloudAgentSetup.subtitle',
                'Choose how Claude Code or Codex gets access in your Orca Cloud workspaces.'
              )}
        </p>
      ) : null}

      <RadioGroup
        layout="cards"
        value={option}
        onValueChange={(next) => {
          const match = options.find((entry) => entry.value === next)
          if (match) {
            choose(match.value)
          }
        }}
        aria-label={t('cloudAgentSetup.optionsLabel', 'How agents get access')}
      >
        {options.map((entry) => (
          <RadioGroupItem key={entry.value} value={entry.value} variant="card">
            <span className="block text-sm font-medium">{entry.title}</span>
            <span className="mt-0.5 block text-xs leading-5 text-muted-foreground">
              {entry.detail}
            </span>
          </RadioGroupItem>
        ))}
      </RadioGroup>

      <CloudAgentSetupFields
        option={option}
        formId={formId}
        errorId={errorId}
        draft={draft}
        onDraft={(patch) => {
          setDraft((current) => ({ ...current, ...patch }))
          setFailure(null)
        }}
        failure={failure}
        signInInVm={onSignIn !== undefined}
        canShare={canShare}
        share={share}
        onShare={setShare}
      />

      <div className="flex items-center justify-between gap-3">
        <p id={errorId} role="alert" className="min-h-4 text-xs text-destructive">
          {errorLine}
        </p>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onLater} disabled={saving}>
            {surface === 'build'
              ? t('cloudAgentSetup.later', 'Set up later')
              : t('cloudSecrets.cancel', 'Cancel')}
          </Button>
          {option === 'sign-in' && !onSignIn ? null : (
            <Button
              type="submit"
              size="sm"
              disabled={
                saving ||
                (option !== 'sign-in' &&
                  (!draft.key.trim() || (option === 'custom' && !draft.baseUrl.trim())))
              }
            >
              {saving ? <Loader2 className="animate-spin" /> : null}
              {option === 'sign-in'
                ? t('cloudAgentSetup.signIn.action', 'Sign in when ready')
                : t('cloudAgentSetup.save', 'Save')}
            </Button>
          )}
        </div>
      </div>
    </form>
  )
}
