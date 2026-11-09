import type {
  ClaudeRateLimitAccountsState,
  CodexRateLimitAccountsState
} from '../../../../shared/managed-account-types'
import type { HostAccountSignInStatus } from '../../../../shared/host-account-sign-in-types'
import { refreshHostAgentSignInReport } from '@/runtime/provider-accounts/sign-in/host-agent-sign-in-status-client'
import {
  cancelHostAccountSignIn,
  hostAccountSignInEnded,
  isLostHostAnswer,
  readHostAccountSignIn,
  signInAgentOnHost,
  submitHostAccountSignInCode,
  subscribeHostAccountSignIns
} from '@/runtime/provider-accounts/sign-in/runtime-host-account-sign-in-client'
import {
  selectClaudeProviderAccount,
  selectCodexProviderAccount
} from '@/runtime/provider-accounts/observations/runtime-provider-accounts-client'
import {
  agentSignInGateEntry,
  closeAgentSignInForward,
  isCurrentAgentSignInGate,
  releaseAgentSignInPane,
  setAgentSignInGateView,
  settleAgentSignInGate,
  type AgentSignInGateView,
  type GateEntry
} from './agent-sign-in-gate-store'

export {
  isAgentSignedOutOnHost,
  readAgentSignInGate,
  requireAgentSignIn,
  useAgentSignInGate,
  type AgentSignInGate,
  type AgentSignInGateView
} from './agent-sign-in-gate-store'

const SIGNED_IN_HOLD_MS = 600

/** Sign-in pages open in the person's own browser, where they are already signed in. */
export function openSignInPage(url: string): void {
  void window.api.shell.openUrl(url)
}

function classifyFailure(error: unknown): Extract<AgentSignInGateView, { step: 'error' }> {
  const message = error instanceof Error ? error.message : String(error)
  if (isLostHostAnswer(error)) {
    return { step: 'error', kind: 'offline', message }
  }
  if (/took too long|timed out/i.test(message)) {
    return { step: 'error', kind: 'timeout', message }
  }
  if (/access_denied|denied|declined/i.test(message)) {
    return { step: 'error', kind: 'declined', message }
  }
  return { step: 'error', kind: 'failed', message }
}

type HostAccounts = ClaudeRateLimitAccountsState | CodexRateLimitAccountsState

/** The account the sign-in just added on the host: the most recently authenticated one there. */
type HostAccountSummary = {
  id: string
  email: string
  lastAuthenticatedAt: number
  managedAuthRuntime?: 'host' | 'wsl'
  managedHomeRuntime?: 'host' | 'wsl'
}

function newestHostAccount(state: HostAccounts | undefined): { id: string; email: string } | null {
  const accounts: readonly HostAccountSummary[] = state?.accounts ?? []
  const onHost = accounts.filter(
    (account) => (account.managedAuthRuntime ?? account.managedHomeRuntime ?? 'host') === 'host'
  )
  onHost.sort((a, b) => b.lastAuthenticatedAt - a.lastAuthenticatedAt)
  return onHost[0] ?? null
}

async function finishSignedIn(entry: GateEntry, status: HostAccountSignInStatus): Promise<void> {
  const owner = { kind: 'environment', environmentId: entry.environmentId } as const
  const account = newestHostAccount(entry.agent === 'claude' ? status.claude : status.codex)
  // Launches use the host's selected account; the one just signed in is the one wanted there.
  if (account) {
    await (
      entry.agent === 'claude'
        ? selectClaudeProviderAccount(owner, { accountId: account.id, runtime: 'host' })
        : selectCodexProviderAccount(owner, { accountId: account.id, runtime: 'host' })
    ).catch(() => {})
  }
  void refreshHostAgentSignInReport(entry.environmentId, { force: true })
  setAgentSignInGateView(entry, { step: 'signed', email: account?.email ?? null })
  setTimeout(() => settleAgentSignInGate(entry, 'proceed'), SIGNED_IN_HOLD_MS)
}

/** Follows the host's sign-in and turns its prompts into card steps until it settles. */
function follow(entry: GateEntry, attempt: number, callback: boolean): void {
  const owner = { kind: 'environment', environmentId: entry.environmentId } as const
  const current = (): boolean => isCurrentAgentSignInGate(entry) && entry.attempt === attempt
  let handledFlowId: string | null = null
  const onStatus = (): void => {
    if (!current()) {
      return
    }
    const status = readHostAccountSignIn(owner, entry.agent)
    const prompt = status?.phase === 'waiting' ? status.prompt : undefined
    if (!status || !prompt || handledFlowId === status.flowId) {
      return
    }
    handledFlowId = status.flowId
    if (prompt.userCode) {
      setAgentSignInGateView(entry, { step: 'device', url: prompt.url, userCode: prompt.userCode })
      return
    }
    if (!callback || prompt.callbackPort === undefined) {
      setAgentSignInGateView(entry, {
        step: 'paste',
        url: prompt.url,
        submitting: false,
        refusal: null
      })
      return
    }
    void openBrowserSignIn(entry, attempt, status.flowId, prompt.callbackPort, prompt)
  }
  const unsubscribe = subscribeHostAccountSignIns(onStatus)
  signInAgentOnHost(owner, entry.agent, { callback })
    .then(
      async (status) => {
        if (current()) {
          await finishSignedIn(entry, status)
        }
      },
      (error: unknown) => {
        if (current()) {
          closeAgentSignInForward(entry)
          setAgentSignInGateView(entry, classifyFailure(error))
        }
      }
    )
    .finally(unsubscribe)
}

async function openBrowserSignIn(
  entry: GateEntry,
  attempt: number,
  flowId: string,
  port: number,
  prompt: NonNullable<HostAccountSignInStatus['prompt']>
): Promise<void> {
  // The web client can't listen on this computer, so it goes straight to the code fallback.
  const open = window.api.runtimeEnvironments.openAuthCallbackForward
  const result = open
    ? await open({ environmentId: entry.environmentId, flowId, port }).catch(() => null)
    : null
  if (!isCurrentAgentSignInGate(entry) || entry.attempt !== attempt) {
    if (result?.ok) {
      void window.api.runtimeEnvironments.closeAuthCallbackForward?.({
        environmentId: entry.environmentId,
        flowId
      })
    }
    return
  }
  if (result?.ok) {
    entry.forwardFlowId = flowId
    openSignInPage(prompt.url)
    setAgentSignInGateView(entry, { step: 'waiting', url: prompt.url })
    return
  }
  if (result?.ok === false && result.code === 'port_busy') {
    entry.attempt += 1
    setAgentSignInGateView(entry, {
      step: 'error',
      kind: 'port_busy',
      message: result.message,
      port
    })
    void cancelHostAccountSignIn(
      { kind: 'environment', environmentId: entry.environmentId },
      entry.agent
    ).catch(() => {})
    return
  }
  // No forward: Claude's paste page still signs in; Codex falls back to its device code.
  if (prompt.pasteUrl) {
    setAgentSignInGateView(entry, {
      step: 'paste',
      url: prompt.pasteUrl,
      submitting: false,
      refusal: null
    })
    return
  }
  void switchToCodeSignIn(entry.key)
}

/** Cancels this client's run on the host and waits for it to end, so a new start can't join it. */
async function stopHostSignIn(entry: GateEntry): Promise<void> {
  const owner = { kind: 'environment', environmentId: entry.environmentId } as const
  await cancelHostAccountSignIn(owner, entry.agent).catch(() => {})
  await hostAccountSignInEnded(owner, entry.agent)
}

function startAttempt(entry: GateEntry, callback: boolean): void {
  entry.attempt += 1
  closeAgentSignInForward(entry)
  setAgentSignInGateView(entry, { step: 'starting' })
  follow(entry, entry.attempt, callback)
}

/** Primary action: browser sign-in (or the code flow on hosts that predate it). */
export function startAgentSignIn(key: string): void {
  const entry = agentSignInGateEntry(key)
  if (entry) {
    startAttempt(entry, !entry.codeOnly)
  }
}

/** Retries after an error, cancelling whatever the host still runs for this agent first. */
export async function retryAgentSignIn(key: string): Promise<void> {
  const entry = agentSignInGateEntry(key)
  if (!entry) {
    return
  }
  entry.attempt += 1
  setAgentSignInGateView(entry, { step: 'starting' })
  await stopHostSignIn(entry)
  startAttempt(entry, !entry.codeOnly)
}

/** Fallback without a forwarded callback: Claude's paste page, or Codex's device code. */
export async function switchToCodeSignIn(key: string): Promise<void> {
  const entry = agentSignInGateEntry(key)
  if (!entry) {
    return
  }
  const owner = { kind: 'environment', environmentId: entry.environmentId } as const
  const pasteUrl = readHostAccountSignIn(owner, entry.agent)?.prompt?.pasteUrl
  if (entry.agent === 'claude' && pasteUrl) {
    // The same Claude login accepts its pasted code; keep the callback open too.
    setAgentSignInGateView(entry, {
      step: 'paste',
      url: pasteUrl,
      submitting: false,
      refusal: null
    })
    return
  }
  entry.attempt += 1
  setAgentSignInGateView(entry, { step: 'starting' })
  await stopHostSignIn(entry)
  startAttempt(entry, false)
}

export async function submitAgentSignInCode(key: string, code: string): Promise<void> {
  const entry = agentSignInGateEntry(key)
  if (!entry || entry.view.step !== 'paste') {
    return
  }
  const paste = entry.view
  setAgentSignInGateView(entry, { ...paste, submitting: true, refusal: null })
  try {
    await submitHostAccountSignInCode(
      { kind: 'environment', environmentId: entry.environmentId },
      entry.agent,
      code
    )
  } catch (error) {
    setAgentSignInGateView(entry, {
      ...paste,
      submitting: false,
      refusal: error instanceof Error ? error.message : String(error)
    })
  }
}

/** Lets one pane leave; the host sign-in stops once no pane waits on it. */
function leave(paneKey: string, outcome: 'proceed' | 'cancel'): void {
  const entry = agentSignInGateEntry(paneKey)
  if (!entry || !releaseAgentSignInPane(paneKey, outcome)) {
    return
  }
  entry.attempt += 1
  void cancelHostAccountSignIn(
    { kind: 'environment', environmentId: entry.environmentId },
    entry.agent
  ).catch(() => {})
  settleAgentSignInGate(entry, outcome)
}

/** Cancel: the pane starts a plain shell instead of the agent. */
export function cancelAgentSignIn(paneKey: string): void {
  leave(paneKey, 'cancel')
}

/** Starts the agent without signing in, for hosts whose own setup the check cannot see. */
export function skipAgentSignIn(paneKey: string): void {
  leave(paneKey, 'proceed')
}

/** Drops a pane that went away; the host sign-in stops if nothing else waits on it. */
export function abandonAgentSignIn(paneKey: string): void {
  leave(paneKey, 'cancel')
}
