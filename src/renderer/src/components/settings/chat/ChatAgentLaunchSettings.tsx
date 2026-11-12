import type { GlobalSettings } from '../../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { useEffect } from 'react'
import { LOCAL_EXECUTION_HOST_ID } from '../../../../../shared/execution-host'
import { getAgentCatalog } from '@/lib/agent-catalog/agent-catalog'
import { AgentIcon } from '@/components/agent/icons/AgentIcon'
import {
  chatProviderAgents,
  managedRuntimeChatAgents,
  useHostStructuredAgentsVersion
} from '@/runtime/native-chat/agent-catalogs/chat-provider-agents'
import { recomputeOn } from '@/lib/recompute-on'
import {
  readChatProgram,
  resolveChatProgramContext
} from '@/lib/agent-session/launch/inventory/host-chat-program'
import { useChatProgramFacts } from '@/lib/agent-session/launch/inventory/host-chat-program-acquisition'
import { useAppStore } from '@/store/index'
import { readNativeDetectedAgents } from '@/store/slices/agent-inventory/local-detected-agent-store-state'
import { Card, CardContent } from '../../ui/card'
import {
  AgentOpensAsControl,
  chatUnavailableOnThisDesktop,
  useAgentChatRuntimeInstall
} from '../../agent/launch-settings/AgentChatChoiceControls'
import {
  buildAgentOpensAs,
  type AgentOpensAs
} from '../../../lib/agent-session/launch/native-chat-provider-choice'
import { ManagedRuntimeInstallRow } from '../../managed-runtime/ManagedRuntimeInstallRow'
import { managedRuntimeInstallPending } from '../../managed-runtime/managed-runtime-install-view'
import {
  antigravityChatSignInPrompt,
  antigravityOrcaRuntimeSignsIn
} from '../../provider-accounts/antigravity-chat-runtime-sign-in-policy'
import { chatSignInLine } from '../../provider-accounts/use-antigravity-chat-sign-in'
import { openAntigravitySignInSettings } from '../../provider-accounts/open-antigravity-sign-in-settings'
import { LoadingSpinner } from '../../LoadingSpinner'
import { Button } from '../../ui/button'
import { SettingsSubsectionHeader } from '../form-controls/SettingsFormControls'
import { getChatLaunchEntriesByKey } from './chat-launch-search'
import { useTranslate } from '@/i18n/use-translate'

const WORKSPACE = { kind: 'floating' } as const

export function ChatAgentLaunchSettings({
  settings,
  updateSettings
}: {
  settings: GlobalSettings
  updateSettings: (updates: Partial<GlobalSettings>) => void | Promise<void>
}): React.JSX.Element {
  const t = useTranslate()
  const hostAgentsVersion = useHostStructuredAgentsVersion()
  useChatProgramFacts(WORKSPACE)
  useEffect(() => {
    void useAppStore.getState().ensureNativeDetectedAgents()
  }, [])
  const detected = useAppStore(readNativeDetectedAgents)
  const chatOnlyKey = useAppStore((state) => {
    const context = resolveChatProgramContext(state, WORKSPACE)
    return chatProviderAgents(LOCAL_EXECUTION_HOST_ID, undefined)
      .filter(
        (agent) =>
          !detected?.includes(agent) &&
          readChatProgram(state, agent, context, detected) === 'available'
      )
      .join(' ')
  })
  const chatOnly = new Set(chatOnlyKey.split(' '))
  const managedChatAgents = recomputeOn([hostAgentsVersion], () =>
    managedRuntimeChatAgents(LOCAL_EXECUTION_HOST_ID, undefined)
  )
  const entry = getChatLaunchEntriesByKey(t).agents
  return (
    <section className="space-y-3">
      <SettingsSubsectionHeader title={entry.title} description={entry.description} />
      <Card size="list">
        <CardContent>
          <div className="divide-y divide-border">
            {getAgentCatalog().map((agent) => {
              const opensAs = recomputeOn([hostAgentsVersion], () =>
                buildAgentOpensAs({
                  agent: agent.id,
                  cliDetected: detected === null ? null : detected.includes(agent.id),
                  chatProgramHere: chatOnly.has(agent.id),
                  settings,
                  updateSettings
                })
              )
              if (!opensAs) {
                return null
              }
              return managedChatAgents.has(agent.id) && !chatUnavailableOnThisDesktop(agent.id) ? (
                <ManagedChatAgentRow
                  key={agent.id}
                  agent={agent.id}
                  label={agent.label}
                  opensAs={opensAs}
                />
              ) : (
                <ChatAgentRow
                  key={agent.id}
                  agent={agent.id}
                  label={agent.label}
                  opensAs={opensAs}
                />
              )
            })}
          </div>
        </CardContent>
      </Card>
    </section>
  )
}

type ChatAgentRowProps = { agent: TuiAgent; label: string; opensAs: AgentOpensAs }

function ChatAgentRow({
  agent,
  label,
  opensAs,
  line = null,
  actions = null
}: ChatAgentRowProps & { line?: React.ReactNode; actions?: React.ReactNode }): React.JSX.Element {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div className="flex min-w-0 items-center gap-3">
        <AgentIcon agent={agent} size={16} />
        <div className="min-w-0">
          <div className="text-sm font-medium">{label}</div>
          {line ? <div className="mt-0.5">{line}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {actions}
        <AgentOpensAsControl label={label} opensAs={opensAs} />
      </div>
    </div>
  )
}

/** Shows the next step the agent's chat still needs here: installing its runtime, then signing in. */
function ManagedChatAgentRow(props: ChatAgentRowProps): React.JSX.Element {
  const t = useTranslate()
  const { runtime, signIn, signInRunning } = useAgentChatRuntimeInstall(props.agent)
  if (runtime.kind !== 'active') {
    return <ChatAgentRow {...props} />
  }
  if (managedRuntimeInstallPending(runtime.snapshot)) {
    return (
      <ManagedRuntimeInstallRow
        observation={runtime}
        agentLabel={props.label}
        signInRunning={signInRunning}
        menu={false}
      >
        {(line, actions) => <ChatAgentRow {...props} line={line} actions={actions} />}
      </ManagedRuntimeInstallRow>
    )
  }
  const prompt =
    props.agent === 'antigravity' && antigravityOrcaRuntimeSignsIn(runtime)
      ? antigravityChatSignInPrompt(signIn)
      : null
  if (prompt === null) {
    return <ChatAgentRow {...props} />
  }
  return (
    <ChatAgentRow
      {...props}
      line={
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-4 flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground"
        >
          {prompt === 'signingIn' ? (
            <>
              <LoadingSpinner className="size-3" />
              {chatSignInLine(signIn.flow, signIn.auth, signIn.openFailed, t)}
            </>
          ) : prompt === 'failed' ? (
            <span className="text-destructive">
              {t('accounts.antigravity.chatFailed', 'Sign-in failed. Try again.')}
            </span>
          ) : (
            <>
              <span aria-hidden className="size-1.5 rounded-full bg-muted-foreground/60" />
              {t('accounts.antigravity.chatBadgeSignedOut', 'Not signed in')}
            </>
          )}
        </div>
      }
      actions={
        <Button size="xs" variant="outline" onClick={openAntigravitySignInSettings}>
          {t('accounts.antigravity.signInEllipsis', 'Sign in…')}
        </Button>
      }
    />
  )
}
