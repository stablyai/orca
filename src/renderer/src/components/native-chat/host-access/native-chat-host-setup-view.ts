import type { AgentCliUpdateView } from '@/components/agent-cli-update/use-agent-cli-update'
import { openAgentSettingsAction } from '@/components/settings/navigation/open-agent-settings'
import { createContext, useContext } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { isAgentSessionSetupFailureKind } from '../../../../../shared/agent-session/failures/agent-session-visible-failures'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { createNativeChatSignInVisibility } from './native-chat-sign-in-visibility'
const SIGN_IN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'notSignedIn',
  'claudeAccountFolderMissing'
])

export function isNativeChatSignInFailureKind(
  kind: string | undefined,
  signIn?: NativeChatSignIn | null
): boolean {
  // The current no-model producer names /login; recheck this if another dialect adopts the kind.
  return (
    kind !== undefined &&
    (SIGN_IN_FAILURE_KINDS.has(kind) ||
      (kind === 'modelNotSelected' && Boolean(signIn?.loginCommand)))
  )
}

/** Failure kinds a host setup step can fix; rows check this before subscribing to the setup context. */
export const isNativeChatSetupFailureKind = isAgentSessionSetupFailureKind

/** Whether a later successful turn resolved the setup failure this row reports. */
export function isNativeChatFailureRowResolved(
  setup: NativeChatHostSetup | null,
  rowId: string | undefined
): boolean {
  return (
    rowId !== undefined &&
    setup?.unresolvedFailureRows !== undefined &&
    !setup.unresolvedFailureRows.has(rowId)
  )
}

export type NativeChatSignIn = {
  signingIn: boolean
  signedIn?: boolean
  lookupFailed?: boolean
  /** A sign-in terminal opened and nothing confirmed it, so the launch keeps its own Retry. */
  unconfirmed?: boolean
  signIn: () => void
  loginCommand?: string
}

export type NativeChatInstall = {
  /** `recheck` after the installer opened: re-reads the host's agents instead of opening another. */
  phase: 'install' | 'recheck'
  busy: boolean
  run: () => void
}

export type NativeChatHostSetup = {
  signIn: NativeChatSignIn | null
  install: NativeChatInstall | null
  /** The user's own CLI update on the chat's host; null for agents Orca can't update. */
  update?: AgentCliUpdateView | null
  /** The chat's host, so setup links open Settings on it. */
  host?: RuntimeClientTarget
  /** Rows whose failure no later successful turn resolved; absent when the transcript is unknown. */
  unresolvedFailureRows?: ReadonlySet<string>
  failureKey?: string
  transcriptFailureId?: string
  resolved?: boolean
  signInInComposer?: boolean
  announcement?: string
  visibility?: ReturnType<typeof createNativeChatSignInVisibility>
}

export const NativeChatHostSetupContext = createContext<NativeChatHostSetup | null>(null)

export function useNativeChatHostSetupView(): NativeChatHostSetup | null {
  return useContext(NativeChatHostSetupContext)
}

/** The one action that fixes `kind` on the chat's host, shared by notices and transcript rows. */
export function nativeChatSetupAction(
  kind: string | undefined,
  setup: NativeChatHostSetup | null | undefined,
  t: Translate = translate
):
  | {
      label: string
      primary: true
      disabled: boolean
      onClick: () => void
    }
  | undefined {
  const signIn = setup?.signIn
  if (
    signIn &&
    !signIn.signedIn &&
    !setup?.resolved &&
    isNativeChatSignInFailureKind(kind, signIn)
  ) {
    return {
      label: signIn.lookupFailed
        ? t('components.native-chat.install.cliRecheck', 'Check again')
        : signIn.signingIn
          ? t('components.native-chat.claudeSignIn.signingIn', 'Signing in…')
          : t('accounts.claude.signIn', 'Sign in'),
      primary: true,
      disabled: signIn.signingIn,
      onClick: signIn.signIn
    }
  }
  const install = setup?.install
  if (install && kind === 'cliMissing') {
    return {
      label:
        install.phase === 'install'
          ? t('components.native-chat.install.cliInstall', 'Install')
          : t('components.native-chat.install.cliRecheck', 'Check again'),
      primary: true,
      disabled: install.busy,
      onClick: install.run
    }
  }
  if (kind === 'agentCommandNotRunnable') {
    return { ...openAgentSettingsAction(setup?.host, t), primary: true }
  }
  return undefined
}
