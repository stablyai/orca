import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../../../shared/agent-launch/catalog/tui-agent'
import { useTranslate } from '@/i18n/use-translate'
import { antigravityChatSignInRunning } from '@/runtime/provider-accounts/sign-in/antigravity-chat-sign-in-status'
import { useManagedRuntimeInstall } from '@/runtime/hosts/installation/use-managed-runtime-install'
import { ManagedRuntimeInstallRow } from '../../managed-runtime/ManagedRuntimeInstallRow'
import { useAntigravityChatSignIn } from '../../provider-accounts/use-antigravity-chat-sign-in'
import { AntigravityProviderSignInArea } from '../../provider-accounts/AntigravityProviderSignInArea'
import { antigravityProviderSignInShown } from '../../provider-accounts/antigravity-chat-runtime-sign-in-policy'
import {
  getHostRuntimeLabel,
  getRuntimeSentenceLabel
} from '../../../lib/provider-accounts/account-runtime-label'
import type { AgentOpensAs } from '../../../lib/agent-session/launch/native-chat-provider-choice'
import { SettingsSegmentedControl } from '../../settings/form-controls/SettingsFormControls'
import { structuredChatUnavailableOnPlatform } from '../../../../../shared/agent-session/structured-chat-platform-support'
import { isWindowsDesktopClient } from '@/lib/files/os-open/windows-path-access'

// The chat choice is this computer's, so the downloaded chat programs are too.
const CHAT_HOST: RuntimeClientTarget = { kind: 'local' }

export function AgentOpensAsControl({
  label,
  opensAs,
  disabled = false
}: {
  label: string
  opensAs: AgentOpensAs
  disabled?: boolean
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <SettingsSegmentedControl<'chat' | 'cli'>
      value={opensAs.value}
      onChange={opensAs.onChange}
      ariaLabel={t('settings.agents.defaultOpensAs', 'Open {{value0}} as', {
        value0: label
      })}
      size="sm"
      options={[
        { value: 'chat', label: t('settings.agents.defaultOpensAsChat', 'Chat'), disabled },
        {
          value: 'cli',
          label: t('settings.agents.defaultOpensAsCli', 'CLI'),
          disabled: disabled || opensAs.cliMissing,
          tooltip: opensAs.cliMissing
            ? t(
                'settings.agents.installCliForTerminal',
                'Install the {{value0}} CLI to open it in a terminal.',
                { value0: label }
              )
            : undefined
        }
      ]}
    />
  )
}

/** This desktop's chat host lacks the agent's chat; false on web clients, whose host OS is unknown. */
export function chatUnavailableOnThisDesktop(agent: string): boolean {
  return structuredChatUnavailableOnPlatform(agent, isWindowsDesktopClient() ? 'win32' : null)
}

/** Why an agent opens in a terminal on a Windows host; the Chat | CLI choice still routes remote hosts. */
export function ChatUnavailableOnWindowsNote({ label }: { label: string }): React.JSX.Element {
  const t = useTranslate()
  return (
    <p className="text-xs text-muted-foreground">
      {t(
        'settings.agents.chatUnavailableOnWindows',
        'On Windows, {{value0}} Chat runs on agy. Install or update agy and sign in with a personal Google account; if Chat is set to a Google Cloud account, choose Personal in Settings. Until then, {{value0}} opens in a terminal.',
        { value0: label }
      )}
    </p>
  )
}

/** The program Orca downloads for an agent's chats, apart from its CLI; mounted only while its row is open. */
export function AgentChatRuntimeArea({
  agent,
  label
}: {
  agent: TuiAgent
  label: string
}): React.JSX.Element | null {
  const t = useTranslate()
  const runtime = useManagedRuntimeInstall(CHAT_HOST, agent, true)
  // Install and Remove wait for a running sign-in, which runs the installed server.
  const signIn = useAntigravityChatSignIn(
    agent === 'antigravity' && runtime.kind === 'active' ? CHAT_HOST : null
  )
  if (chatUnavailableOnThisDesktop(agent)) {
    return <ChatUnavailableOnWindowsNote label={label} />
  }
  if (runtime.kind !== 'active') {
    return null
  }
  return (
    <div className="space-y-2">
      <ManagedRuntimeInstallRow
        observation={runtime}
        agentLabel={label}
        signInRunning={antigravityChatSignInRunning(signIn.flow)}
      >
        {(line, actions) => (
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-xs font-medium leading-none">
                {t('settings.agents.chatRuntime', 'Chat runtime')}
              </p>
              <div className="mt-1">{line}</div>
            </div>
            {actions}
          </div>
        )}
      </ManagedRuntimeInstallRow>
      {agent === 'antigravity' && antigravityProviderSignInShown(runtime) ? (
        <AntigravityProviderSignInArea
          owner={CHAT_HOST}
          label={getRuntimeSentenceLabel({ runtime: 'host', label: getHostRuntimeLabel(t) })}
          install={runtime}
        />
      ) : null}
    </div>
  )
}
