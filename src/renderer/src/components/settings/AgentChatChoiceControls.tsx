import type { RuntimeClientTarget } from '../../../../shared/runtime-client-target'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { translate } from '@/i18n/i18n'
import { antigravityChatSignInRunning } from '@/runtime/antigravity-chat-sign-in-status'
import { useManagedRuntimeInstall } from '@/runtime/use-managed-runtime-install'
import { ManagedRuntimeInstallRow } from '../managed-runtime/ManagedRuntimeInstallRow'
import { useAntigravityChatSignIn } from './AntigravityChatSignInRow'
import {
  AntigravityProviderSignInArea,
  antigravityProviderSignInShown
} from './AntigravityProviderSignInArea'
import { getHostRuntimeLabel, getRuntimeSentenceLabel } from './accounts-pane-runtime'
import type { AgentOpensAs } from './native-chat-provider-choice'
import { SettingsSegmentedControl } from './SettingsFormControls'

// The chat choice is this computer's, so the downloaded chat programs are too.
const CHAT_HOST: RuntimeClientTarget = { kind: 'local' }

export function AgentOpensAsControl({
  label,
  opensAs
}: {
  label: string
  opensAs: AgentOpensAs
}): React.JSX.Element {
  return (
    <SettingsSegmentedControl<'chat' | 'cli'>
      value={opensAs.value}
      onChange={opensAs.onChange}
      ariaLabel={translate('settings.agents.defaultOpensAs', 'Open {{value0}} as', {
        value0: label
      })}
      size="sm"
      options={[
        { value: 'chat', label: translate('settings.agents.defaultOpensAsChat', 'Chat') },
        {
          value: 'cli',
          label: translate('settings.agents.defaultOpensAsCli', 'CLI'),
          disabled: opensAs.cliMissing,
          tooltip: opensAs.cliMissing
            ? translate(
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

/** The program Orca downloads for an agent's chats, apart from its CLI; mounted only while its row is open. */
export function AgentChatRuntimeArea({
  agent,
  label
}: {
  agent: TuiAgent
  label: string
}): React.JSX.Element | null {
  const runtime = useManagedRuntimeInstall(CHAT_HOST, agent, true)
  // Install and Remove wait for a running sign-in, which runs the installed server.
  const signIn = useAntigravityChatSignIn(
    agent === 'antigravity' && runtime.kind === 'active' ? CHAT_HOST : null
  )
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
                {translate('settings.agents.chatRuntime', 'Chat runtime')}
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
          label={getRuntimeSentenceLabel({ runtime: 'host', label: getHostRuntimeLabel() })}
          install={runtime}
        />
      ) : null}
    </div>
  )
}
