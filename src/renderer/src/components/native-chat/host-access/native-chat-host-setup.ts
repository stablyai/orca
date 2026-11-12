import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { readAgentInventoryForTarget } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { runtimeHostPlatform } from '@/components/terminal-pane/pty-transport/host-ownership/pty-owner-machine-platform'
import {
  agentSessionInstallCommand,
  agentSessionSignInCommand
} from '../../../../../shared/agent-session/lifecycle/agent-session-setup-commands'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/agent-session-availability'
import type { RuntimeClientTarget } from '../../../../../shared/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveHostAgentStartupShell } from '../../../../../shared/windows-terminal-shell'
import {
  useNativeChatHostCommandTerminal,
  type NativeChatHostCommandTerminal
} from './native-chat-host-command-terminal'

const SIGN_IN_FAILURE_KINDS: ReadonlySet<string> = new Set([
  'notSignedIn',
  'claudeAccountFolderMissing'
])

function isNativeChatSignInFailureKind(
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
export function isNativeChatSetupFailureKind(kind: string | undefined): boolean {
  return kind === 'modelNotSelected' || kind === 'cliMissing' || isNativeChatSignInFailureKind(kind)
}

export type NativeChatSignIn = {
  signingIn: boolean
  signIn: () => void
  loginCommand?: string
}

type NativeChatInstall = {
  /** `recheck` after the installer opened: re-reads the host's agents instead of opening another. */
  phase: 'install' | 'recheck'
  busy: boolean
  run: () => void
}

export type NativeChatHostSetup = {
  signIn: NativeChatSignIn | null
  install: NativeChatInstall | null
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
): { label: string; primary: true; disabled: boolean; onClick: () => void } | undefined {
  const signIn = setup?.signIn
  if (signIn && isNativeChatSignInFailureKind(kind, signIn)) {
    return {
      label: signIn.signingIn
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
  return undefined
}

/** Offer selected-account sign-in until successful, then suppress it until the failure or failure-row count changes. */
function useManagedClaudeSignIn(
  accountId: string | null,
  failure: unknown,
  failureRows: number
): NativeChatSignIn | null {
  const [signingIn, setSigningIn] = useState(false)
  // Why a ref: the notice and a transcript row both sign in, and state lags a double press.
  const signingInRef = useRef(false)
  const [signedInFor, setSignedInFor] = useState<{ failure: unknown; rows: number } | null>(null)
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

type NativeChatHostSetupInput = {
  agent: string
  target: RuntimeClientTarget
  worktreeId: string | null
  groupId?: string
  account: AgentSessionAccountKind | undefined
  failure: unknown
  startFailures: readonly { kind: string }[]
  /** After a recheck reads the host's agents, so the chat can retry what the install fixed. */
  onRechecked: () => void
}

function useNativeChatSignIn(
  input: NativeChatHostSetupInput,
  terminal: NativeChatHostCommandTerminal | null
): NativeChatSignIn | null {
  // Why local only: the hidden sign-in runs on this device, and Claude chats run on its host.
  const accountId = useAppStore((s) =>
    input.agent === 'claude' && input.target.kind === 'local' && input.account !== 'system'
      ? (s.settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
        s.settings?.activeClaudeManagedAccountId ??
        null)
      : null
  )
  const managed = useManagedClaudeSignIn(
    accountId,
    input.failure,
    input.startFailures.filter((fact) => isNativeChatSignInFailureKind(fact.kind)).length
  )
  const shell = useAppStore((s) => {
    const status =
      input.target.kind === 'environment'
        ? lastVerifiedRuntimeStatus(s.runtimeStatusByEnvironmentId.get(input.target.environmentId))
        : null
    const platform = input.target.kind === 'local' ? getRendererAppPlatform() : status?.hostPlatform
    if (!platform) {
      return null
    }
    return (
      resolveHostAgentStartupShell({
        platform,
        isRemote: input.target.kind !== 'local',
        hostTerminalWindowsShell:
          input.target.kind === 'local'
            ? s.settings?.terminalWindowsShell
            : status?.terminalWindowsShell
      }) ?? (platform === 'win32' ? null : 'posix')
    )
  })
  const command = agentSessionSignInCommand(input.agent, {
    account: input.account,
    remote: input.target.kind !== 'local',
    shell
  })
  const viaTerminal = useMemo(
    () =>
      command && terminal
        ? {
            signingIn: terminal.opening,
            signIn: () => void terminal.open(command),
            loginCommand: command
          }
        : null,
    [command, terminal]
  )
  // A managed account owns sign-in: a terminal login after it succeeds would sign in another account.
  return accountId ? managed : viaTerminal
}

function useNativeChatInstall(
  input: NativeChatHostSetupInput,
  terminal: NativeChatHostCommandTerminal | null
): NativeChatInstall | null {
  const { worktreeId, onRechecked } = input
  const environmentId = input.target.kind === 'environment' ? input.target.environmentId : null
  const command = agentSessionInstallCommand(
    input.agent,
    useAppStore((s) =>
      environmentId ? runtimeHostPlatform(s, environmentId) : getRendererAppPlatform()
    )
  )
  const [opened, setOpened] = useState(false)
  const [rechecking, setRechecking] = useState(false)
  const recheck = useCallback(() => {
    const state = useAppStore.getState()
    const reportFailure = () =>
      toast.error(
        translate(
          'components.native-chat.install.cliRecheckFailed',
          'Could not check installed agents on this host. Try again.'
        )
      )
    setRechecking(true)
    void (
      environmentId
        ? state.refreshRuntimeDetectedAgents(environmentId, worktreeId)
        : state.refreshDetectedAgents(worktreeId, { wakeWslDistro: true })
    )
      .then(() => {
        // Refreshes can resolve with cached agents after failure; check their explicit outcome.
        const inventory = readAgentInventoryForTarget(
          useAppStore.getState(),
          environmentId
            ? { kind: 'runtime', environmentId, worktreeId }
            : { kind: 'local', worktreeId }
        )
        if (inventory.state === 'successful') {
          setOpened(false)
          onRechecked()
        } else {
          reportFailure()
        }
      })
      .catch(reportFailure)
      .finally(() => setRechecking(false))
  }, [environmentId, worktreeId, onRechecked])
  return useMemo(
    () =>
      command && terminal
        ? {
            phase: opened ? ('recheck' as const) : ('install' as const),
            busy: terminal.opening || rechecking,
            run: opened
              ? recheck
              : () => {
                  void terminal.open(command).then((didOpen) => {
                    if (didOpen) {
                      setOpened(true)
                    }
                  })
                }
          }
        : null,
    [command, terminal, opened, rechecking, recheck]
  )
}

/** Sign-in and install for a chat's own host; each is null where that host can't run it. */
export function useNativeChatHostSetup(input: NativeChatHostSetupInput): NativeChatHostSetup {
  // One terminal for both, so a double press across them can't open two.
  const terminal = useNativeChatHostCommandTerminal(input)
  const signIn = useNativeChatSignIn(input, terminal)
  const install = useNativeChatInstall(input, terminal)
  return useMemo(() => ({ signIn, install }), [signIn, install])
}
