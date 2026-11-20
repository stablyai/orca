import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { openAntigravitySignInSettings } from '@/components/provider-accounts/open-antigravity-sign-in-settings'
import { agentSessionSetupFor } from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { AgentSessionFailureFact } from '../../../../../shared/agent-session/failures/agent-session-failure'
import { agentSessionFailureSentence } from '../../../../../shared/agent-session/failures/agent-session-failure-words'
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
  /** Replaces the sentence where Sign in needs a step it can't do itself, so the step never hides in a tooltip. */
  steps?: string
}

export function nativeChatNotSignedInSentence(agentName: string, t: Translate = translate): string {
  return t('components.native-chat.signInNotice.notSignedIn', "{{agent}} isn't signed in.", {
    agent: agentName
  })
}

/** The host's words for a not-signed-in failure when they say more than its standard sentence
 *  (a provider's diagnostic, an older host's advice): kept behind Details, never dropped. */
export function nativeChatSignInHostWords(
  text: string | undefined,
  fact: AgentSessionFailureFact,
  agentName: string | undefined
): string | undefined {
  const words = text?.trim()
  if (!words) {
    return undefined
  }
  const context = agentName ? { agentName } : {}
  const standard = (['row', 'rejection'] as const).flatMap((surface) =>
    [context, { ...context, messageSubmitted: false }, { ...context, retryControl: true }].map(
      (wording) => agentSessionFailureSentence(fact, surface, wording)
    )
  )
  return standard.includes(words) ? undefined : words
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
  // An older host's chats on Orca's retired server sign in from Settings there; agy's (`system`)
  // sign in by running agy.
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
  // Pi and OMP open their CLI; the user still types its login command there.
  const slashCommand =
    signIn.loginCommand && entry && 'slashCommand' in entry ? entry.slashCommand : null
  return {
    signedIn: false,
    button: {
      label: signIn.signingIn
        ? t('components.native-chat.claudeSignIn.signingIn', 'Signing in…')
        : t('components.native-chat.signInNotice.signIn', 'Sign in'),
      description: signInDescription(entry, signIn, t),
      busy: signIn.signingIn,
      onClick: signIn.signIn
    },
    ...(slashCommand
      ? {
          // The icon and button say it isn't signed in; one line must fit at the narrowest chat.
          steps: t(
            'components.native-chat.signInNotice.thenSlashCommand',
            'Sign in, then type {{slashCommand}}.',
            { slashCommand }
          )
        }
      : {})
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
  return t('components.native-chat.signInNotice.runsCommand', 'Runs {{command}} in a terminal', {
    command
  })
}
