// Share desktop/mobile saved-conversation startups using host platform, actual shell and launch settings.

import { isAntigravityReferenceSession } from './antigravity-session-origin'
import type { AiVaultAgent, AiVaultSession } from './ai-vault-types'
import {
  buildAiVaultResumeCommand,
  buildAiVaultResumeShellCommand,
  realHomeCodexResumeEnvDeletion
} from './ai-vault-resume-command'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from './agent-session-resume'
import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'
import {
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from './tui-agent-launch-defaults'
import { buildAgentResumeStartupPlan } from './tui-agent-startup'
import {
  quoteStartupArg,
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from './tui-agent-startup-shell'
import { getTuiAgentLaunchCommand, isTuiAgent, TUI_AGENT_CONFIG } from './tui-agent-config'
import { findOptionOccurrence } from './command-option-occurrence'
import { assertOpenCodeCopyUsesLocalStore } from './opencode-launch-command'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from './structured-agent-cli-conversation-adoption'
import type { GlobalSettings } from './global-settings-types'
import { parseWslUncPath } from './wsl-paths'
import { managedDataAccountResumeEnv } from './managed-data-account-resume'

export type AiVaultResumeCommandSession = Pick<
  AiVaultSession,
  'agent' | 'sessionId' | 'cwd' | 'codexHome'
> &
  Partial<
    Pick<AiVaultSession, 'executionHostId' | 'executionHostPlatform' | 'resumeCommand' | 'filePath'>
  >

export type AiVaultResumeStartup = {
  agent?: AiVaultSession['agent']
  command: string
  cwd?: string
  env?: Record<string, string>
  envToDelete?: string[]
  launchConfig?: SleepingAgentLaunchConfig
  providerSession?: AgentProviderSessionMetadata
}

export type AiVaultResumeLaunchSettings = Partial<Pick<GlobalSettings, 'agentCmdOverrides'>> &
  AgentLaunchProfileSettings

/** The platform and live shell a resume line is written for, and the Codex home it pins. */
export type AiVaultResumeHostShell = {
  platform: NodeJS.Platform
  codexHome: string | null
  liveShell: AgentStartupShell | undefined
}

type AiVaultResumeStartupArgs = {
  session: AiVaultResumeCommandSession
  host: AiVaultResumeHostShell
  settings: AiVaultResumeLaunchSettings | null | undefined
  commandOverride?: string | null
}

export function getAiVaultResumeCodexHome(
  codexHome: string | null,
  platform: NodeJS.Platform
): string | null {
  // Translate WSL UNC Codex homes to POSIX only for Linux targets.
  if (!codexHome || platform !== 'linux') {
    return codexHome
  }
  return parseWslUncPath(codexHome)?.linuxPath ?? codexHome
}

export function getAiVaultAgentProviderSession(
  session: Pick<AiVaultSession, 'agent' | 'sessionId'> & { filePath?: string }
): AgentProviderSessionMetadata | null {
  if (!isResumableTuiAgent(session.agent)) {
    return null
  }
  if (isAntigravityReferenceSession(session)) {
    return null
  }
  if (session.agent === 'antigravity' || session.agent === 'cursor') {
    return { key: 'conversation_id', id: session.sessionId }
  }
  if (session.agent === 'pi' || session.agent === 'prime-agent') {
    return session.filePath
      ? { key: 'session_id', id: session.sessionId, transcriptPath: session.filePath }
      : null
  }
  return { key: 'session_id', id: session.sessionId }
}

function resumeCommandOverrides(
  args: AiVaultResumeStartupArgs
): NonNullable<GlobalSettings['agentCmdOverrides']> {
  return {
    ...args.settings?.agentCmdOverrides,
    ...(args.commandOverride?.trim() ? { [args.session.agent]: args.commandOverride } : {})
  }
}

/** A resume run on the host itself: no prebuilt remote command and no Antigravity reference. */
export function buildAiVaultLocalResumeStartup(
  args: AiVaultResumeStartupArgs & {
    agentArgs?: string
    embedCwd: boolean
    /** Copy-path only: names the pasted line must strip off the agent itself.
     *  Spawned startups drop them through `envToDelete` instead. */
    clearEnvNames?: readonly string[]
  }
): AiVaultResumeStartup {
  const { session, settings, embedCwd, clearEnvNames } = args
  const { platform, codexHome, liveShell } = args.host
  const resumeFilePath = normalizeAiVaultResumeFilePath(session.filePath, platform)
  // Why: Pi resumes by transcript path, spelled for the shell it runs in (#24408).
  const localProviderSession = getAiVaultAgentProviderSession({
    ...session,
    filePath: resumeFilePath
  })
  const cwd = embedCwd ? session.cwd : null
  const startupCwd = !embedCwd && session.cwd ? { cwd: session.cwd } : {}
  if (localProviderSession && isResumableTuiAgent(session.agent)) {
    const startupPlan = buildAgentResumeStartupPlan({
      agent: session.agent,
      providerSession: localProviderSession,
      cmdOverrides: resumeCommandOverrides(args),
      platform,
      shell: liveShell,
      agentArgs: args.agentArgs ?? resolveTuiAgentLaunchArgs(session.agent, settings),
      agentEnv: {
        ...resolveTuiAgentLaunchEnv(session.agent, settings, platform),
        ...managedDataAccountResumeEnv(session)
      },
      resumeInLaunchCwd: true,
      ...(session.agent === 'omp' && resumeFilePath ? { ompResumeFilePath: resumeFilePath } : {})
    })
    if (startupPlan) {
      return {
        command:
          session.agent === 'omp'
            ? buildAiVaultResumeCommand({
                agent: session.agent,
                sessionId: session.sessionId,
                resumeFilePath,
                cwd,
                platform,
                commandOverride: startupPlan.launchConfig.agentCommand,
                codexHome,
                shell: liveShell,
                clearEnvNames
              })
            : buildAiVaultResumeShellCommand({
                resumeCommand: startupPlan.launchCommand,
                cwd,
                platform,
                codexHome,
                shell: liveShell,
                clearEnvNames
              }),
        ...(startupPlan.env ? { env: startupPlan.env } : {}),
        ...realHomeCodexResumeEnvDeletion(session),
        ...startupCwd,
        launchConfig: startupPlan.launchConfig,
        providerSession: localProviderSession
      }
    }
  }

  return {
    command: buildAiVaultResumeCommand({
      agent: session.agent,
      sessionId: session.sessionId,
      // Forward OMP transcript paths during local rebuilds so custom/WSL stores cannot fall back to default-store ID lookup.
      resumeFilePath,
      cwd,
      platform,
      commandOverride: args.commandOverride,
      codexHome,
      // Fallbacks also handle non-resumable agents; quote for the live Windows shell like startup plans.
      shell: liveShell,
      clearEnvNames
    }),
    ...startupCwd,
    ...realHomeCodexResumeEnvDeletion(session)
  }
}

/** Return null without fork support: plain resume would create a second writer on the chat's conversation. Omit providerSession because the copy owns a new ID and cold restore must not resume the source. */
export function buildAiVaultForkStartup(
  args: AiVaultResumeStartupArgs
): AiVaultResumeStartup | null {
  const { session, settings } = args
  const { platform, codexHome, liveShell } = args.host
  const providerSession = getAiVaultAgentProviderSession({
    ...session,
    filePath: normalizeAiVaultResumeFilePath(session.filePath, platform)
  })
  if (!providerSession || !isResumableTuiAgent(session.agent)) {
    return null
  }
  const plan = buildAgentResumeStartupPlan({
    agent: session.agent,
    providerSession,
    cmdOverrides: resumeCommandOverrides(args),
    platform,
    shell: liveShell,
    agentArgs: resolveTuiAgentLaunchArgs(session.agent, settings),
    agentEnv: resolveTuiAgentLaunchEnv(session.agent, settings, platform),
    resumeInLaunchCwd: true,
    fork: true
  })
  if (!plan) {
    return null
  }
  return {
    command: buildAiVaultResumeShellCommand({
      resumeCommand: plan.launchCommand,
      cwd: null,
      platform,
      codexHome,
      shell: liveShell
    }),
    ...(plan.env ? { env: plan.env } : {}),
    ...realHomeCodexResumeEnvDeletion(session),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    launchConfig: plan.launchConfig
  }
}

/** The agent arguments a copied conversation opens with: the source chat's launch mode, then the
 *  configured arguments. */
export function resolveAiVaultCopiedSessionAgentArgs(
  args: AiVaultResumeStartupArgs & { sourceAgent: AiVaultAgent }
): string {
  const { session, settings, sourceAgent } = args
  const { platform, liveShell } = args.host
  const shell = resolveStartupShell(platform, liveShell)
  const configuredArgs = isTuiAgent(session.agent)
    ? resolveTuiAgentLaunchArgs(session.agent, settings)
    : ''
  const configured = tokenizeStartupCommand(configuredArgs, shell)
  if (!configured.ok) {
    throw new Error('This session cannot be opened in the CLI.')
  }
  const commandOverride =
    args.commandOverride?.trim() || settings?.agentCmdOverrides?.[session.agent]?.trim()
  const mode =
    sourceAgent !== session.agent &&
    isTuiAgent(sourceAgent) &&
    !commandOverride &&
    !findOptionOccurrence(configured.tokens, ['--standalone'], true)
      ? tokenizeStartupCommand(
          getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[sourceAgent], platform),
          shell
        )
      : null
  if (mode && !mode.ok) {
    throw new Error('This session cannot be opened in the CLI.')
  }
  return [
    mode?.ok
      ? mode.tokens
          .slice(1)
          .map((token) => quoteStartupArg(token, shell))
          .join(' ')
      : '',
    configuredArgs
  ]
    .filter(Boolean)
    .join(' ')
}

/** Check every possible chat-owning CLI before copying: OpenCode copies live in the local store and launch args must not redirect them. */
export function assertAiVaultCopiedSessionStoreAllowed(args: AiVaultResumeStartupArgs): void {
  const row = args.session.agent
  if (row !== 'opencode' && row !== 'opencode2') {
    return
  }
  const { platform, liveShell } = args.host
  for (const agent of CLI_CONVERSATION_ADOPTING_AGENTS[row]) {
    const command =
      (agent === row ? args.commandOverride?.trim() : undefined) ||
      args.settings?.agentCmdOverrides?.[agent] ||
      getTuiAgentLaunchCommand(TUI_AGENT_CONFIG[agent], platform)
    const parsed = tokenizeStartupCommand(
      `${command} ${resolveTuiAgentLaunchArgs(agent, args.settings)}`,
      resolveStartupShell(platform, liveShell)
    )
    if (!parsed.ok) {
      throw new Error('This session cannot be opened in the CLI.')
    }
    assertOpenCodeCopyUsesLocalStore(parsed.tokens.slice(1))
  }
}
