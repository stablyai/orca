import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store'
import { signInToClaudeAccount } from '@/lib/claude-account-sign-in'
import { agentSessionRemoteSignInCommand } from '../../../../../shared/agent-session/lifecycle/agent-session-sign-in'
import { persistAgentLaunchTabOrder } from '@/lib/agent-session/launch/pane/launch-agent-tab-order'
import { createWebRuntimeSessionTerminalOnHost } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-creation'
import { notifyWebRuntimeTerminalCreateFailure } from '@/runtime/hosted-terminals/creation/web-runtime-terminal-create-failure-notice'
import { startStoppedWslHostForUserAct } from '@/lib/wsl-host-user-start'
import { toast } from 'sonner'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'

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

export type NativeChatSignIn = {
  signingIn: boolean
  signIn: () => void
  loginCommand?: string
}

export const NativeChatSignInContext = createContext<NativeChatSignIn | null>(null)

export function useNativeChatSignInView(): NativeChatSignIn | null {
  return useContext(NativeChatSignInContext)
}

export function nativeChatSignInLabel(signIn: NativeChatSignIn, t: Translate = translate): string {
  return signIn.signingIn
    ? t('components.native-chat.claudeSignIn.signingIn', 'Signing in…')
    : t('accounts.claude.signIn', 'Sign in')
}

/** Offer local selected-account sign-in until successful, then suppress it until the failure or failure-row count changes. */
function useManagedClaudeSignIn(input: {
  agent: string
  target: RuntimeClientTarget
  failure: unknown
  failureRows: number
}): NativeChatSignIn | null {
  // Why local only: the hidden sign-in runs on this device, and Claude chats run on its host.
  const accountId = useAppStore((s) =>
    input.agent === 'claude' && input.target.kind === 'local'
      ? (s.settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
        s.settings?.activeClaudeManagedAccountId ??
        null)
      : null
  )
  const [signingIn, setSigningIn] = useState(false)
  // Why a ref: the notice and a transcript row both sign in, and state lags a double press.
  const signingInRef = useRef(false)
  const [signedInFor, setSignedInFor] = useState<{ failure: unknown; rows: number } | null>(null)
  const { failure, failureRows } = input
  const signIn = useCallback(() => {
    if (!accountId || signingInRef.current) {
      return
    }
    signingInRef.current = true
    setSigningIn(true)
    void signInToClaudeAccount(accountId)
      .then((signedIn) => {
        if (signedIn) {
          setSignedInFor({ failure, rows: failureRows })
        }
      })
      .finally(() => {
        signingInRef.current = false
        setSigningIn(false)
      })
  }, [accountId, failure, failureRows])
  const signedInSinceFailure =
    signedInFor !== null && signedInFor.failure === failure && signedInFor.rows === failureRows
  // Why memoized: rows read it through context, and a chat re-renders on every streamed token.
  return useMemo(
    () => (accountId && !signedInSinceFailure ? { signingIn, signIn } : null),
    [accountId, signedInSinceFailure, signingIn, signIn]
  )
}

const TERMINAL_SIGN_IN_AGENTS: ReadonlySet<string> = new Set(['opencode', 'opencode2', 'pi', 'omp'])

export function useNativeChatSignIn(input: {
  agent: string
  target: RuntimeClientTarget
  worktreeId: string | null
  groupId?: string
  failure: unknown
  startFailures: readonly { kind: string }[]
}): NativeChatSignIn | null {
  const managed = useManagedClaudeSignIn({
    ...input,
    failureRows: input.startFailures.filter((fact) => isNativeChatSignInFailureKind(fact.kind))
      .length
  })
  const command = TERMINAL_SIGN_IN_AGENTS.has(input.agent)
    ? agentSessionRemoteSignInCommand(input.agent)
    : null
  const { worktreeId, groupId } = input
  const environmentId = input.target.kind === 'environment' ? input.target.environmentId : null
  const [opening, setOpening] = useState(false)
  const openingRef = useRef(false)
  const signIn = useCallback(() => {
    if (!command || !worktreeId || openingRef.current) {
      return
    }
    openingRef.current = true
    setOpening(true)
    void (async () => {
      if (environmentId) {
        if (!(await startStoppedWslHostForUserAct(environmentId))) {
          return
        }
        const outcome = await createWebRuntimeSessionTerminalOnHost(
          {
            worktreeId,
            environmentId,
            targetGroupId: groupId,
            command,
            viewMode: 'terminal',
            activate: true
          },
          { notifyFailure: false }
        )
        if (outcome.status === 'failed') {
          notifyWebRuntimeTerminalCreateFailure(outcome.message, { environmentId, worktreeId })
        }
      } else {
        const store = useAppStore.getState()
        const tab = store.createTab(worktreeId, groupId, undefined, {
          pendingStartup: { command },
          viewMode: 'terminal'
        })
        store.setActiveTabType('terminal', worktreeId)
        persistAgentLaunchTabOrder(worktreeId, tab.id)
      }
    })()
      .catch(() => {
        toast.error(
          translate(
            'auto.store.slices.worktrees.localBaseRefUnshallowFailed',
            'Could not open a terminal for this workspace'
          )
        )
      })
      .finally(() => {
        openingRef.current = false
        setOpening(false)
      })
  }, [command, worktreeId, groupId, environmentId])
  const terminal = useMemo(
    () => (command && worktreeId ? { signingIn: opening, signIn, loginCommand: command } : null),
    [command, worktreeId, opening, signIn]
  )
  return managed ?? terminal
}
