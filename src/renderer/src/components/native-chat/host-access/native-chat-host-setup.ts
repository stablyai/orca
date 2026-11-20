import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'
import type { Translate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import {
  signInShell,
  useBashProbe
} from '@/runtime/hosts/capabilities/windows-terminal-sign-in-shell'
import { readAgentInventoryForTarget } from '@/lib/agent-session/launch/inventory/agent-detection-target-inventory'
import { runtimeHostPlatform } from '@/components/terminal-pane/pty-transport/host-ownership/pty-owner-machine-platform'
import {
  agentSessionInstallCommand,
  agentSessionSignInCommand,
  agentSessionSignInEnv
} from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionUnresolvedFailureRows,
  isAgentSessionSetupFailureKind
} from '../../../../../shared/agent-session/failures/agent-session-visible-failures'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import {
  useNativeChatHostCommandTerminal,
  type NativeChatHostCommandTerminal
} from './native-chat-host-command-terminal'
import type { AgentCliUpdateView } from '@/components/agent-cli-update/use-agent-cli-update'
import { useNativeChatCliUpdate } from './native-chat-cli-update'
import { openAgentSettingsAction } from '@/components/settings/navigation/open-agent-settings'

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
  /** Signed in since this failure; nothing to press until the user sends again. */
  signedIn?: boolean
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
  /** The user's own CLI update on the chat's host; null for agents Orca can't update. */
  update?: AgentCliUpdateView | null
  /** The chat's host, so setup links open Settings on it. */
  host?: RuntimeClientTarget
  /** Rows whose failure no later successful turn resolved; absent when the transcript is unknown. */
  unresolvedFailureRows?: ReadonlySet<string>
  /** The composer's notice shows Sign in, so transcript rows only say what wasn't sent. */
  signInInComposer?: boolean
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
  if (signIn && !signIn.signedIn && isNativeChatSignInFailureKind(kind, signIn)) {
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
  if (kind === 'agentCommandNotRunnable') {
    return { ...openAgentSettingsAction(setup?.host, t), primary: true }
  }
  return undefined
}

/** Offer selected-account sign-in until successful, then report signed in until the failure or failure-row count changes. */
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
    () => (accountId ? { signingIn, signedIn: signedInSinceFailure, signIn } : null),
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
  journalItems: readonly AgentJournalRenderItem[]
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
  useBashProbe(input.target.kind === 'local')
  const shell = useAppStoreWithHostStatuses((s, statuses) => {
    const status =
      input.target.kind === 'environment'
        ? lastVerifiedRuntimeStatus(statuses.get(input.target.environmentId))
        : null
    const platform = input.target.kind === 'local' ? getRendererAppPlatform() : status?.hostPlatform
    return signInShell({
      platform,
      isRemote: input.target.kind !== 'local',
      hostTerminalWindowsShell:
        input.target.kind === 'local'
          ? s.settings?.terminalWindowsShell
          : status?.terminalWindowsShell
    })
  })
  const command = agentSessionSignInCommand(input.agent, {
    account: input.account,
    remote: input.target.kind !== 'local',
    shell
  })
  const { agent } = input
  const viaTerminal = useMemo(
    () =>
      command && terminal
        ? {
            signingIn: terminal.opening,
            signIn: () => void terminal.open(command, agentSessionSignInEnv(agent)),
            loginCommand: command
          }
        : null,
    [agent, command, terminal]
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
    useAppStoreWithHostStatuses((_s, statuses) =>
      environmentId ? runtimeHostPlatform(statuses, environmentId) : getRendererAppPlatform()
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
        ? state.refreshRuntimeDetectedAgents(environmentId, worktreeId, { userInitiated: true })
        : state.refreshDetectedAgents(worktreeId, { wakeWslDistro: true, userInitiated: true })
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
  const update = useNativeChatCliUpdate(input.target, input.agent, input.onRechecked)
  const { target, journalItems } = input
  // Keyed by its ids so a streamed reply leaves the set, and the rows reading it, alone.
  const unresolvedKey = useMemo(
    // Sent messages too: a refused one's line can offer the fix.
    () => agentSessionUnresolvedFailureRows(journalItems, { sentMessages: true }).join('\n'),
    [journalItems]
  )
  const unresolvedFailureRows = useMemo(() => new Set(unresolvedKey.split('\n')), [unresolvedKey])
  return useMemo(
    () => ({
      signIn,
      install,
      update,
      host: target,
      unresolvedFailureRows
    }),
    [signIn, install, update, target, unresolvedFailureRows]
  )
}
