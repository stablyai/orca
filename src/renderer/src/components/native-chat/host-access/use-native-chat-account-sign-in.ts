import { useCallback, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/index'
import { useNativeChatAgySignIn } from './native-chat-agy-sign-in'
import { useAppStoreWithHostStatuses } from '@/store/slices/runtime-status/views/use-runtime-status-view'
import { translate } from '@/i18n/i18n'
import { signInToClaudeAccount } from '@/lib/provider-accounts/claude-account-sign-in'
import { getRendererAppPlatform } from '@/app-shell/platform/renderer-app-platform'
import { callStructuredAgentSession } from '@/runtime/native-chat/requests/structured-agent-session-call'
import { structuredAgentSessionHostSupports } from '@/runtime/native-chat/host-capabilities/structured-agent-session-host-support'
import { AGENT_SESSION_MODEL_CATALOG_CONFIRM_SIGN_IN_RUNTIME_CAPABILITY } from '../../../../../shared/agent-session/capabilities/structured-agent-session-surface-capabilities'
import type { AgentSessionModelCatalogResult } from '../../../../../shared/agent-session/agent-session-wire'
import type { RuntimeClientTarget } from '../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { AgentSessionAccountKind } from '../../../../../shared/agent-session/failures/agent-session-availability'
import type { AgentJournalRenderItem } from '../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  agentSessionSignInCommand,
  agentSessionSignInEnv
} from '../../../../../shared/agent-session/lifecycle/launch/agent-session-setup-commands'
import { lastVerifiedRuntimeStatus } from '../../../../../shared/remote-runtime/host-status/runtime-host-status'
import { resolveHostAgentStartupShell } from '../../../../../shared/shell/launch/windows-terminal-shell'
import type { NativeChatHostCommandTerminal } from './native-chat-host-command-terminal'
import { useNativeChatCodexRecoveryAccount } from './use-native-chat-codex-recovery-account'
import {
  useNativeChatTerminalSignInRecheck,
  type NativeChatTerminalSignIn
} from './use-native-chat-terminal-sign-in-recheck'
export type NativeChatHostSetupInput = {
  agent: string
  target: RuntimeClientTarget
  worktreeId: string | null
  groupId?: string
  sessionId?: string
  isVisible?: boolean
  failureKey?: string
  transcriptFailureId?: string
  needsSignIn?: boolean
  account: AgentSessionAccountKind | undefined
  failure: unknown
  startFailures: readonly { kind: string }[]
  journalItems: readonly AgentJournalRenderItem[]
  onRechecked: () => void
  onSignInRechecked?: () => void
}

export function useNativeChatSignIn(
  input: NativeChatHostSetupInput,
  terminal: NativeChatHostCommandTerminal | null
) {
  const {
    agent,
    sessionId,
    account,
    failureKey = '',
    needsSignIn,
    target,
    onSignInRechecked
  } = input
  const local = input.target.kind === 'local'
  const claudeAccountId = useAppStore((s) =>
    agent === 'claude' && local && account !== 'system'
      ? (s.settings?.activeClaudeManagedAccountIdsByRuntime?.host ??
        s.settings?.activeClaudeManagedAccountId ??
        null)
      : null
  )
  const codexIdentity = local && agent === 'codex' && account !== 'system' ? sessionId : undefined
  const codexSelection = useAppStore((s) =>
    codexIdentity && needsSignIn
      ? (s.settings?.activeCodexManagedAccountIdsByRuntime?.host ??
        s.settings?.activeCodexManagedAccountId ??
        null)
      : null
  )
  const {
    accountId: codexAccountId,
    lastAccountId,
    blocksTerminal,
    failed: codexLookupFailed,
    retry: retryCodexLookup
  } = useNativeChatCodexRecoveryAccount(codexIdentity, needsSignIn, failureKey, codexSelection)
  const shell = useAppStoreWithHostStatuses((s, statuses) => {
    const status =
      input.target.kind === 'environment'
        ? lastVerifiedRuntimeStatus(statuses.get(input.target.environmentId))
        : null
    const platform = local ? getRendererAppPlatform() : status?.hostPlatform
    if (!platform) {
      return null
    }
    return (
      resolveHostAgentStartupShell({
        platform,
        isRemote: !local,
        hostTerminalWindowsShell: local
          ? s.settings?.terminalWindowsShell
          : status?.terminalWindowsShell
      }) ?? (platform === 'win32' ? null : 'posix')
    )
  })
  const command = agentSessionSignInCommand(agent, { account, remote: !local, shell })
  const terminalAllowed = !(agent === 'codex' && account === 'managed') && !blocksTerminal
  const identity = JSON.stringify([
    agent,
    target.kind === 'environment' ? target.environmentId : null,
    sessionId,
    lastAccountId ?? claudeAccountId ?? account,
    codexSelection,
    failureKey
  ])
  const [state, setState] = useState<{
    identity: string
    busy: boolean
    resolved: boolean
    /** A sign-in terminal opened and nothing confirmed it: the user may have signed in there. */
    unconfirmed: boolean
    announcement: string
  }>({
    identity,
    busy: false,
    resolved: false,
    unconfirmed: false,
    announcement: ''
  })
  if (state.identity !== identity) {
    setState({ identity, busy: false, resolved: false, unconfirmed: false, announcement: '' })
  }
  const inFlight = useRef(false)
  const [terminalSignIn, setTerminalSignIn] = useState<NativeChatTerminalSignIn | null>(null)
  const attempt = useRef(0)
  useLayoutEffect(
    () => () => {
      ++attempt.current
      inFlight.current = false
    },
    [identity]
  )
  const resolved = state.identity === identity && state.resolved
  const busy = state.identity === identity && state.busy
  const recheck = useCallback(
    async (ticket: number) => {
      if (!sessionId || ticket !== attempt.current) {
        return false
      }
      const supportsSignInCheck = await structuredAgentSessionHostSupports(
        target,
        AGENT_SESSION_MODEL_CATALOG_CONFIRM_SIGN_IN_RUNTIME_CAPABILITY
      )
      if (!supportsSignInCheck || ticket !== attempt.current) {
        return false
      }
      const result = await callStructuredAgentSession<AgentSessionModelCatalogResult>(
        target,
        'agentSession.modelCatalog',
        { agent, sessionId, confirmSignIn: true }
      ).catch(() => null)
      return ticket === attempt.current && result?.signInConfirmed === true
    },
    [agent, sessionId, target]
  )
  const finish = useCallback(
    (ticket: number, signedIn: boolean) => {
      if (ticket !== attempt.current) {
        return
      }
      inFlight.current = false
      if (!signedIn) {
        // Many hosts and agents can't confirm a terminal login; claim neither success nor failure.
        setState((current) => ({ ...current, busy: false, unconfirmed: true }))
        return
      }
      setState({
        identity,
        busy: false,
        resolved: true,
        unconfirmed: false,
        announcement: translate('components.native-chat.signIn.succeeded', 'Signed in.')
      })
      onSignInRechecked?.()
    },
    [identity, onSignInRechecked]
  )
  if (terminalSignIn && terminalSignIn.identity !== identity) {
    setTerminalSignIn(null)
  }
  useNativeChatTerminalSignInRecheck(
    terminalSignIn,
    input.isVisible,
    recheck,
    (ticket, signedIn) => {
      setTerminalSignIn((signIn) => (signIn?.ticket === ticket ? null : signIn))
      finish(ticket, signedIn)
    }
  )
  const { worktreeId } = input
  const signIn = useCallback(() => {
    if (inFlight.current) {
      return
    }
    // A repeat press returns to the login terminal still open instead of opening another.
    if (terminalSignIn?.tabId && terminal?.show(terminalSignIn.tabId)) {
      return
    }
    inFlight.current = true
    setTerminalSignIn(null)
    const ticket = ++attempt.current
    setState((current) => ({
      identity,
      busy: true,
      resolved: false,
      unconfirmed: current.identity === identity && current.unconfirmed,
      announcement: ''
    }))
    void (async () => {
      if (codexAccountId && sessionId) {
        await window.api.codexAccounts.reauthenticate({ accountId: codexAccountId, sessionId })
        await useAppStore.getState().fetchSettings()
      } else if (claudeAccountId) {
        if (!(await signInToClaudeAccount(claudeAccountId))) {
          throw new Error('Sign-in cancelled or failed')
        }
      } else if (command && terminal && terminalAllowed) {
        const opened = await terminal.open(command, agentSessionSignInEnv(agent))
        if (!opened) {
          throw new Error('Sign-in terminal did not open')
        }
        if (ticket === attempt.current) {
          setTerminalSignIn({ identity, ticket, worktreeId, tabId: opened.tabId })
          inFlight.current = false
          setState((current) => ({ ...current, busy: false, unconfirmed: true }))
        }
        return
      } else {
        throw new Error('Sign-in unavailable')
      }
      finish(ticket, true)
    })().catch(() => {
      if (ticket !== attempt.current) {
        return
      }
      if (codexAccountId) {
        retryCodexLookup()
      }
      inFlight.current = false
      setState({
        identity,
        busy: false,
        resolved: false,
        unconfirmed: false,
        announcement: translate(
          'components.native-chat.signIn.cancelled',
          'Sign-in cancelled or failed. Try again.'
        )
      })
    })
  }, [
    identity,
    codexAccountId,
    claudeAccountId,
    sessionId,
    agent,
    command,
    terminal,
    terminalAllowed,
    worktreeId,
    terminalSignIn,
    retryCodexLookup,
    finish
  ])
  const available = Boolean(
    codexAccountId || claudeAccountId || (command && terminal && terminalAllowed)
  )
  const unconfirmed = state.identity === identity && state.unconfirmed && !resolved
  const signInView = useMemo(
    () =>
      codexLookupFailed && !busy && !resolved && !available
        ? { lookupFailed: true, signingIn: false, signIn: retryCodexLookup }
        : available
          ? {
              signingIn: busy,
              signedIn: resolved,
              ...(unconfirmed ? { unconfirmed: true } : {}),
              signIn,
              ...(command && !codexAccountId && !claudeAccountId ? { loginCommand: command } : {})
            }
          : null,
    [
      available,
      resolved,
      busy,
      unconfirmed,
      signIn,
      command,
      codexAccountId,
      claudeAccountId,
      codexLookupFailed,
      retryCodexLookup
    ]
  )
  // agy signs in from Orca, so its terminal command (`system`) never runs from here.
  const antigravity = useNativeChatAgySignIn(agent, account, target)
  const announcement = state.identity === identity ? state.announcement : ''
  return useMemo(
    () => ({ signIn: antigravity ?? signInView, resolved, announcement }),
    [antigravity, signInView, resolved, announcement]
  )
}
