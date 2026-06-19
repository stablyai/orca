import type { AutoSwitchRateLimitAgent } from '../../../shared/agent-rate-limit-detection'
import type { AgentProviderSessionMetadata } from '../../../shared/agent-session-resume'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from '../../../shared/tui-agent-launch-defaults'
import { useAppStore } from '@/store'
import { sendRuntimePtyInputVerified } from '@/runtime/runtime-terminal-inspection'
import { getRemoteRuntimePtyEnvironmentId } from '@/runtime/runtime-terminal-stream'
import { callRuntimeRpc, type RuntimeClientTarget } from '@/runtime/runtime-rpc-client'
import { translate } from '@/i18n/i18n'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import {
  selectAutoSwitchAccount,
  type AutoSwitchAccountCandidate,
  type AutoSwitchAccountsSnapshot
} from './agent-rate-limit-auto-switch'
import {
  stopForegroundAgent,
  waitForAgentReadyInput,
  waitForResumedAgent
} from './agent-rate-limit-terminal-control'
import { resolveAgentRateLimitResumePlatform } from './agent-rate-limit-resume-platform'

export type AgentRateLimitAutoSwitchResult =
  | { ok: true; agent: AutoSwitchRateLimitAgent; accountLabel: string }
  | {
      ok: false
      reason:
        | 'disabled'
        | 'ssh'
        | 'no-account'
        | 'stop-failed'
        | 'resume-failed'
        | 'continue-failed'
        | 'switch-failed'
      message: string
    }

type AccountsSnapshotResult = {
  accounts: AutoSwitchAccountsSnapshot
  target: RuntimeClientTarget
}

/** Formats unknown async failures for toast-safe structured runner results. */
function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Refreshes local inactive-account quota data before selecting an auto-switch target. */
async function loadLocalAccountsSnapshot(agent: AutoSwitchRateLimitAgent): Promise<{
  accounts: AutoSwitchAccountsSnapshot
  target: RuntimeClientTarget
}> {
  const fetchInactive =
    agent === 'claude'
      ? window.api.rateLimits.fetchInactiveClaudeAccounts
      : window.api.rateLimits.fetchInactiveCodexAccounts
  await fetchInactive()
  const [claude, codex, rateLimits] = await Promise.all([
    window.api.claudeAccounts.list(),
    window.api.codexAccounts.list(),
    window.api.rateLimits.get()
  ])
  useAppStore.getState().setRateLimitsFromPush(rateLimits)
  return { accounts: { claude, codex, rateLimits }, target: { kind: 'local' } }
}

/** Loads managed-account and quota state from the PTY-owning runtime. */
async function loadAccountsSnapshot(args: {
  agent: AutoSwitchRateLimitAgent
  ptyId: string
}): Promise<AccountsSnapshotResult> {
  const environmentId = getRemoteRuntimePtyEnvironmentId(args.ptyId)
  if (!environmentId) {
    return loadLocalAccountsSnapshot(args.agent)
  }
  const target = { kind: 'environment', environmentId } as const
  const accounts = await callRuntimeRpc<AutoSwitchAccountsSnapshot>(
    target,
    'accounts.list',
    undefined,
    { timeoutMs: 30_000 }
  )
  return { accounts, target }
}

/** Selects the chosen managed account in the same runtime where the PTY is running. */
async function selectAccount(args: {
  agent: AutoSwitchRateLimitAgent
  runtimeTarget: RuntimeClientTarget
  candidate: AutoSwitchAccountCandidate
}): Promise<void> {
  if (args.runtimeTarget.kind === 'environment') {
    await callRuntimeRpc(
      args.runtimeTarget,
      args.agent === 'claude' ? 'accounts.selectClaude' : 'accounts.selectCodex',
      { accountId: args.candidate.accountId },
      { timeoutMs: 30_000 }
    )
    return
  }

  const selection = {
    accountId: args.candidate.accountId,
    runtime: args.candidate.target.runtime,
    wslDistro: args.candidate.target.wslDistro
  }
  const selectManagedAccount =
    args.agent === 'claude' ? window.api.claudeAccounts.select : window.api.codexAccounts.select
  await selectManagedAccount(selection)
  await useAppStore.getState().fetchSettings()
}

/** Runs the stop/switch/resume/continue flow for a detected account-limit event. */
export async function runAgentRateLimitAutoSwitch(args: {
  ptyId: string
  agent: AutoSwitchRateLimitAgent
  providerSession: AgentProviderSessionMetadata
  connectionId: string | null
}): Promise<AgentRateLimitAutoSwitchResult> {
  const settings = useAppStore.getState().settings
  if (settings?.autoSwitchRateLimitedAccounts !== true) {
    return {
      ok: false,
      reason: 'disabled',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.07ff1f8806',
        'Auto-switch is disabled.'
      )
    }
  }
  if (args.connectionId) {
    return {
      ok: false,
      reason: 'ssh',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.7e5d87791a',
        'Auto-switch is not available for SSH terminals because account auth lives on the remote host.'
      )
    }
  }

  let snapshot: AccountsSnapshotResult
  try {
    snapshot = await loadAccountsSnapshot({ agent: args.agent, ptyId: args.ptyId })
  } catch (error) {
    return {
      ok: false,
      reason: 'switch-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.65e8e278a4',
        'Could not inspect managed accounts: {{value0}}',
        { value0: errorMessage(error) }
      )
    }
  }
  const providerTarget =
    args.agent === 'claude'
      ? snapshot.accounts.rateLimits.claudeTarget
      : snapshot.accounts.rateLimits.codexTarget
  const candidate = selectAutoSwitchAccount({
    agent: args.agent,
    accounts: snapshot.accounts,
    target:
      snapshot.target.kind === 'environment' ? { runtime: 'host', wslDistro: null } : providerTarget
  })
  if (!candidate) {
    return {
      ok: false,
      reason: 'no-account',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.d823b157d5',
        'No managed {{value0}} account with available quota was found.',
        { value0: args.agent === 'claude' ? 'Claude' : 'Codex' }
      )
    }
  }

  let platform: NodeJS.Platform
  try {
    platform = await resolveAgentRateLimitResumePlatform({
      target: snapshot.target,
      accountTarget: candidate.target
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'resume-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.a939f58b30',
        'Could not resolve the resume platform: {{value0}}',
        { value0: errorMessage(error) }
      )
    }
  }
  const localSettings = snapshot.target.kind === 'local' ? settings : null
  const resumePlan = buildAgentResumeStartupPlan({
    agent: args.agent,
    providerSession: args.providerSession,
    cmdOverrides: localSettings?.agentCmdOverrides ?? {},
    agentArgs: resolveTuiAgentLaunchArgs(args.agent, localSettings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(args.agent, localSettings?.agentDefaultEnv),
    platform
  })
  if (!resumePlan) {
    return {
      ok: false,
      reason: 'resume-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.79751c2c2d',
        'Could not build a resume command for the limited agent session.'
      )
    }
  }

  const stopped = await stopForegroundAgent({
    settings,
    ptyId: args.ptyId,
    agent: args.agent,
    expectedProcess: resumePlan.expectedProcess
  })
  if (!stopped) {
    return {
      ok: false,
      reason: 'stop-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.13668a6034',
        'The limited agent did not exit after Ctrl+C, so Orca left the terminal untouched.'
      )
    }
  }

  try {
    await selectAccount({
      agent: args.agent,
      runtimeTarget: snapshot.target,
      candidate
    })
  } catch (error) {
    return {
      ok: false,
      reason: 'switch-failed',
      message: error instanceof Error ? error.message : String(error)
    }
  }

  const launched = await sendRuntimePtyInputVerified(
    useAppStore.getState().settings,
    args.ptyId,
    `${resumePlan.launchCommand}\r`
  )
  if (!launched) {
    return {
      ok: false,
      reason: 'resume-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.9553d26436',
        'The terminal did not accept the resume command after switching accounts.'
      )
    }
  }

  const resumed = await waitForResumedAgent({
    settings: useAppStore.getState().settings,
    ptyId: args.ptyId,
    agent: args.agent,
    expectedProcess: resumePlan.expectedProcess
  })
  if (!resumed) {
    return {
      ok: false,
      reason: 'resume-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.13ccffb514',
        'The resumed agent did not take over the terminal in time.'
      )
    }
  }

  await waitForAgentReadyInput()
  const continued = await sendRuntimePtyInputVerified(
    useAppStore.getState().settings,
    args.ptyId,
    'continue\r'
  )
  if (!continued) {
    return {
      ok: false,
      reason: 'continue-failed',
      message: translate(
        'auto.lib.agentRateLimitAutoSwitchRunner.65d1f14b75',
        'The resumed agent did not accept the continue command.'
      )
    }
  }

  return { ok: true, agent: args.agent, accountLabel: candidate.label }
}
