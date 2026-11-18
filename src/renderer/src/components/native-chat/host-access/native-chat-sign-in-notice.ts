import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import { agentSessionSetupFor } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { NativeChatHostSetup, NativeChatSignIn } from './native-chat-host-setup'

export type NativeChatSignInButton = {
  label: string
  /** Where the press goes: the button's tooltip and accessible description. */
  description: string
  busy: boolean
  onClick: () => void
}

export type NativeChatSignInNoticeView = {
  signedIn: boolean
  button: NativeChatSignInButton | null
}

export function nativeChatNotSignedInSentence(agentName: string, t: Translate = translate): string {
  return t('components.native-chat.signInNotice.notSignedIn', "{{agent}} isn't signed in.", {
    agent: agentName
  })
}

/** The one-line sign-in notice, or null where this chat has no Sign in, so the notice keeps the sentence that says how. */
export function nativeChatSignInNoticeView(
  input: {
    kind: string | undefined
    /** Agent id or display name. */
    agent: string | undefined
    account?: AgentSessionAccountKind
    setup: NativeChatHostSetup | null | undefined
  },
  t: Translate = translate
): NativeChatSignInNoticeView | null {
  if (input.kind !== 'notSignedIn') {
    return null
  }
  const entry = agentSessionSetupFor(input.agent)
  // Antigravity chats keep Orca's own sign-in; chats on the host's agy (`system`) use agy's.
  if (entry?.agent === 'antigravity' && input.account !== 'system') {
    const host = input.setup?.host
    return {
      signedIn: false,
      button: {
        label: t('accounts.antigravity.signInEllipsis', 'Sign in…'),
        description: t(
          'components.native-chat.signInNotice.opensAntigravitySettings',
          'Opens Settings → Accounts → Antigravity'
        ),
        busy: false,
        onClick: () => openAntigravitySignInSettings(host)
      }
    }
  }
  const signIn = input.setup?.signIn
  if (!signIn) {
    return null
  }
  if (signIn.signedIn) {
    return { signedIn: true, button: null }
  }
  return {
    signedIn: false,
    button: {
      label: signIn.signingIn
        ? t('components.native-chat.claudeSignIn.signingIn', 'Signing in…')
        : t('components.native-chat.signInNotice.signIn', 'Sign in'),
      description: signInDescription(entry, signIn, t),
      busy: signIn.signingIn,
      onClick: signIn.signIn
    }
  }
}

function signInDescription(
  entry: ReturnType<typeof agentSessionSetupFor>,
  signIn: NativeChatSignIn,
  t: Translate
): string {
  if (!signIn.loginCommand) {
    return t(
      'components.native-chat.signInNotice.signsInClaudeAccount',
      'Signs in this Claude account'
    )
  }
  // Claude's system login is a wrapper script; name the command the user would recognize.
  const command = entry?.agent === 'claude' ? entry.loginCommand.join(' ') : signIn.loginCommand
  return entry && 'slashCommand' in entry
    ? t(
        'components.native-chat.signInNotice.runsCommandThenSlash',
        'Runs {{command}} in a terminal. Type {{slashCommand}} there to sign in.',
        { command, slashCommand: entry.slashCommand }
      )
    : t('components.native-chat.signInNotice.runsCommand', 'Runs {{command}} in a terminal', {
        command
      })
}
