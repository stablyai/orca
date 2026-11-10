import { useId, useImperativeHandle, useRef, useState } from 'react'
import { CircleCheck, Loader2 } from 'lucide-react'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { HOST_AGENT_SIGN_IN_AGENT_NAME as AGENT_NAME } from '../../../../shared/host-agent-sign-in-status'
import { cn } from '@/lib/utils'
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
import { isOwnKeyEvent } from '../settings/cloud-secrets/CloudSecretEditor'

export type { CloudAgentSetupFailure, CloudAgentSetupOption, CloudAgentSetupScope }
export type CloudAgentSetupSaved = { agents: CloudSetupAgent[]; scope: CloudAgentSetupScope }
type KeyOption = Exclude<CloudAgentSetupOption, 'sign-in'>

const KEY_OPTIONS: readonly KeyOption[] = ['api-key', 'gateway', 'custom']
const EMPTY_DRAFTS: Record<KeyOption, CloudAgentSetupDraft> = {
  'api-key': EMPTY_DRAFT,
  gateway: EMPTY_DRAFT,
  custom: EMPTY_DRAFT
}

/** "Claude: provided by your team · Codex: not set up", for the Subscription tab. */
function agentStatusLine(readiness: CloudAgentReadiness, t: Translate): string {
  return CLOUD_SETUP_AGENTS.map((agent) => {
    const source = readiness[agent]
    const state =
      source === 'team'
        ? t('cloudAgentSetup.status.team', 'provided by your team')
        : source === 'desktop-key'
          ? t('cloudAgentSetup.status.desktopKey', 'API key from Orca on this computer')
          : source === 'cloud-secret'
            ? t('cloudAgentSetup.status.cloudSecret', 'your cloud secret')
            : t('cloudAgentSetup.status.none', 'not set up')
    return `${AGENT_NAME[agent]}: ${state}`
  }).join(' · ')
}

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
            t(
              'cloudAgentSetup.source.desktopKey',
              '{{agent}} uses the API key from Orca on this computer',
              {
                agent
              }
            )
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
  /** Build sheet: start in-VM sign-in. Without it (Settings) the Subscription tab explains and closes. */
  onSignIn?: () => void
  onSave: (
    choice: CloudAgentSetupChoice,
    scope: CloudAgentSetupScope
  ) => Promise<CloudAgentSetupFailure | null>
  onSaved: (saved: CloudAgentSetupSaved) => void
  onCancel: () => void
  /** Build sheet: the form opens from a button that unmounts, so focus moves into it. */
  focusOnOpen?: boolean
  /** Dialog: tabs of different heights keep one floor so the centred dialog does not jump. */
  steadyHeight?: boolean
  /**
   * Dialog: its Escape runs before the form sees the key. Returns true when Escape was held back to
   * ask before a typed key is thrown away.
   */
  escapeGuardRef?: React.Ref<() => boolean>
  /** Fixtures only. */
  initialOption?: CloudAgentSetupOption
  initialFailure?: CloudAgentSetupFailure | null
}

/** The ways Claude Code or Codex can get access in Orca Cloud with a key, plus sign-in in the dialog. */
export function CloudAgentSetupView({
  readiness,
  canShare,
  onSignIn,
  onSave,
  onSaved,
  onCancel,
  focusOnOpen = false,
  steadyHeight = false,
  escapeGuardRef,
  initialOption,
  initialFailure = null
}: CloudAgentSetupViewProps): React.JSX.Element {
  const t = useTranslate()
  const formId = useId()
  const options: readonly CloudAgentSetupOption[] = ['sign-in', ...KEY_OPTIONS]
  const [option, setOption] = useState<CloudAgentSetupOption>(initialOption ?? options[0])
  // One draft per way in, so moving between tabs never loses what was typed.
  const [drafts, setDrafts] = useState<Record<KeyOption, CloudAgentSetupDraft>>(EMPTY_DRAFTS)
  const draft = option === 'sign-in' ? EMPTY_DRAFT : drafts[option]
  const [share, setShare] = useState(false)
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<CloudAgentSetupFailure | null>(initialFailure)
  const summary = readiness ? cloudAgentReadinessSummary(readiness, t) : ''
  // A stray Escape must not throw away a key that was typed or pasted: ask first.
  const typedKey = KEY_OPTIONS.some((entry) => drafts[entry].key.trim() !== '')
  const [askedToDiscard, setConfirmDiscard] = useState(false)
  // The question lapses with what it guards: a cleared key, or a save under way.
  const confirmDiscard = askedToDiscard && typedKey && !saving
  const returnFocus = useRef<HTMLElement | null>(null)
  const holdEscape = (): boolean => {
    if (saving || !typedKey || confirmDiscard) {
      return false
    }
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    setConfirmDiscard(true)
    return true
  }
  useImperativeHandle(escapeGuardRef, () => holdEscape)
  const keepEditing = (): void => {
    setConfirmDiscard(false)
    const target = returnFocus.current
    requestAnimationFrame(() => target?.isConnected && target.focus())
  }

  const labels: Record<CloudAgentSetupOption, { tab: string; detail: string }> = {
    'sign-in': {
      tab: t('cloudAgentSetup.option.signIn', 'Subscription'),
      detail: t(
        'cloudAgentSetup.option.signInDialog',
        'Sign in once inside a cloud workspace. Agent sign-ins stay on the sandbox’s disk, including through sleep.'
      )
    },
    'api-key': {
      tab: t('cloudAgentSetup.option.apiKey', 'Agent key'),
      detail: t(
        'cloudAgentSetup.option.apiKeyDetail',
        'An Anthropic or OpenAI API key, billed by usage.'
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
    setConfirmDiscard(false)
    setSaving(true)
    setFailure(null)
    const result = await onSave(choice, scope)
    setSaving(false)
    if (result) {
      setFailure(result)
      return
    }
    setDrafts(EMPTY_DRAFTS)
    onSaved({ agents: agentsFor(choice), scope })
  }

  const canSubmit =
    option !== 'sign-in' &&
    draft.key.trim() !== '' &&
    (option !== 'custom' || draft.baseUrl.trim() !== '')
  // Field problems sit under their field; only ones without a field land in the footer.
  const footerError =
    failure && failure.field === undefined
      ? failure.error === 'unavailable' ||
        failure.error === 'timeout' ||
        failure.error === 'unknown'
        ? t(
            'cloudAgentSetup.notSaved',
            'Couldn’t reach Orca Cloud. Your key wasn’t saved. Try again.'
          )
        : cloudSecretsErrorCopy(failure.error, t)
      : null

  return (
    <form
      onSubmit={(event) => void submit(event)}
      onKeyDown={(event) => {
        // Escape from a portaled Select or menu bubbles here too; let it close only that.
        if (event.key === 'Escape' && !saving && isOwnKeyEvent(event)) {
          event.stopPropagation()
          // The dialog's own Escape handler runs first and has already asked.
          if (event.nativeEvent.defaultPrevented) {
            return
          }
          if (!holdEscape()) {
            onCancel()
          }
        }
      }}
      className="space-y-3"
      aria-label={t('cloudAgentSetup.title', 'Add an agent')}
    >
      {summary ? (
        <div className="flex items-center gap-2 rounded-md bg-muted/40 px-3 py-2 text-xs">
          <CircleCheck aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          <span>{summary}</span>
        </div>
      ) : null}
      <Tabs
        value={option}
        // Arrow keys move focus only; a tab opens on Enter or Space, so nothing jumps while browsing.
        activationMode="manual"
        onValueChange={(next) => {
          const match = options.find((entry) => entry === next)
          if (match) {
            setOption(match)
            setFailure(null)
          }
        }}
      >
        <TabsList size="sm">
          {options.map((entry) => (
            <TabsTrigger key={entry} value={entry} autoFocus={focusOnOpen && entry === option}>
              {labels[entry].tab}
            </TabsTrigger>
          ))}
        </TabsList>
        {options.map((entry) => (
          <TabsContent key={entry} value={entry}>
            {/* A fixed floor keeps the footer still while tabs of different heights swap. */}
            <div className={cn('space-y-3 pt-1', steadyHeight && 'min-h-56')}>
              <p className="text-xs leading-5 text-muted-foreground">{labels[entry].detail}</p>
              {entry === 'sign-in' ? (
                readiness ? (
                  <p className="text-xs text-muted-foreground">{agentStatusLine(readiness, t)}</p>
                ) : null
              ) : (
                <CloudAgentSetupFields
                  option={entry}
                  formId={formId}
                  draft={drafts[entry]}
                  onDraft={(patch) => {
                    setDrafts((current) => ({
                      ...current,
                      [entry]: { ...current[entry], ...patch }
                    }))
                    setFailure(null)
                  }}
                  failure={failure}
                  canShare={canShare}
                  share={share}
                  onShare={setShare}
                  onSignInInstead={() => setOption('sign-in')}
                />
              )}
            </div>
          </TabsContent>
        ))}
      </Tabs>

      <div className="flex items-center justify-between gap-3">
        <p
          role="alert"
          className={cn('min-h-4 text-xs', confirmDiscard ? 'text-foreground' : 'text-destructive')}
        >
          {confirmDiscard
            ? t('cloudAgentSetup.discardQuestion', 'Discard the key you typed?')
            : footerError}
        </p>
        {confirmDiscard ? (
          <div className="flex shrink-0 gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
              {t('cloudAgentSetup.discard', 'Discard')}
            </Button>
            <Button type="button" size="sm" autoFocus onClick={keepEditing}>
              {t('cloudAgentSetup.keepEditing', 'Keep editing')}
            </Button>
          </div>
        ) : (
          <div className="flex shrink-0 gap-2">
            {/* Settings' Subscription tab has nothing to cancel: Got it is the only way out. */}
            {option === 'sign-in' && !onSignIn ? null : (
              <Button type="button" variant="ghost" size="sm" onClick={() => !saving && onCancel()}>
                {t('cloudSecrets.cancel', 'Cancel')}
              </Button>
            )}
            {option === 'sign-in' ? (
              <Button type="button" size="sm" onClick={onSignIn ?? onCancel}>
                {onSignIn
                  ? t('cloudAgentSetup.signIn.action', 'Sign in when ready')
                  : t('cloudAgentSetup.gotIt', 'Got it')}
              </Button>
            ) : (
              <Button
                type="submit"
                size="sm"
                disabled={!canSubmit}
                aria-disabled={saving || undefined}
                aria-busy={saving || undefined}
              >
                {saving ? <Loader2 className="animate-spin" /> : null}
                {t('cloudAgentSetup.save', 'Save')}
              </Button>
            )}
          </div>
        )}
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
