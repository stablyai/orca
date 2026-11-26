// Share desktop/mobile saved-conversation startups using host platform, actual shell and launch settings.

import { isAntigravityReferenceSession } from '../../agent-session/lifecycle/provider-handles/antigravity-session-origin'
import type { AiVaultSession } from '../contracts/ai-vault-types'
import {
  buildAiVaultResumeCommand,
  realHomeCodexResumeEnvDeletion
} from './ai-vault-resume-command'
import {
  isResumableTuiAgent,
  type AgentProviderSessionMetadata,
  type SleepingAgentLaunchConfig
} from '../../agent-session/lifecycle/agent-session-resume'
import { normalizeAiVaultResumeFilePath } from './ai-vault-resume-path'
import {
  resolveTuiAgentLaunchRawArgs,
  resolveTuiAgentLaunchEnv,
  type AgentLaunchProfileSettings
} from '../../agent-launch/choices/tui-agent-launch-defaults'
import {
  buildAgentResumeStartupPlan,
  buildAgentTypedResumeStartupPlan
} from '../../agent-launch/startup/tui-agent-resume-startup'
import {
  withManagedAgentProgram,
  type ManagedAgentCommands
} from '../../agent-launch/startup/managed-agent-launch-program'
import {
  resolveStartupShell,
  tokenizeStartupCommand,
  type AgentStartupShell
} from '../../agent-launch/startup/tui-agent-startup-shell'
import {
  getTuiAgentLaunchCommand,
  TUI_AGENT_CONFIG
} from '../../agent-launch/catalog/tui-agent-config'
import { assertOpenCodeCopyUsesLocalStore } from '../../agent-launch/startup/opencode-launch-command'
import { CLI_CONVERSATION_ADOPTING_AGENTS } from '../../agent-session/view/structured-agent-cli-conversation-adoption'
import type { GlobalSettings } from '../../settings/global-settings-types'
import { managedDataAccountResumeEnv } from '../../agent-launch/environment/managed-data-account-resume'
import { buildAntigravityReferenceStartup } from './ai-vault-antigravity-reference-startup'

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
  /** OS that runs the agent when `platform` is only a quoting guess; null when unreported, absent when `platform`. */
  agentHostPlatform?: NodeJS.Platform | null
  codexHome: string | null
  liveShell: AgentStartupShell | undefined
}

type AiVaultResumeStartupArgs = {
  session: AiVaultResumeCommandSession
  host: AiVaultResumeHostShell
  settings: AiVaultResumeLaunchSettings | null | undefined
  commandOverride?: string | null
  /** User executables found outside PATH on the resume's host. */
  managedAgentCommands?: ManagedAgentCommands
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
  // A Hermes row's `<store>#<id>` names the profile every resume, restore and host rebuild must pin.
  if (session.agent === 'hermes' && session.filePath?.includes('#')) {
    return { key: 'session_id', id: session.sessionId, transcriptPath: session.filePath }
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

/** OMP rebuilds its resume line from the recorded command, including a user CLI found outside PATH. */
function ompResumeProgram(
  recorded: string | undefined,
  args: AiVaultResumeStartupArgs,
  platform: NodeJS.Platform,
  shell: AgentStartupShell | undefined
): string | undefined {
  if (!args.managedAgentCommands?.omp) {
    return recorded
  }
  return withManagedAgentProgram(
    recorded ?? getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.omp, platform),
    {
      agent: 'omp',
      cmdOverrides: resumeCommandOverrides(args),
      managedAgentCommands: args.managedAgentCommands,
      platform,
      shell: resolveStartupShell(platform, shell)
    }
  )
}

/** A resume run on the host itself: no prebuilt remote command. */
export function buildAiVaultLocalResumeStartup(
  args: AiVaultLocalResumeStartupArgs
): AiVaultResumeStartup {
  return buildAiVaultResumeStartup(args, buildAgentResumeStartupPlan)
}

export function buildAiVaultTypedResumeStartup(
  args: AiVaultLocalResumeStartupArgs
): AiVaultResumeStartup {
  return buildAiVaultResumeStartup(args, buildAgentTypedResumeStartupPlan)
}

type AiVaultLocalResumeStartupArgs = AiVaultResumeStartupArgs & {
  agentArgs?: string
  embedCwd: boolean
  /** Copy-path only: names the pasted line must strip off the agent itself.
   *  Spawned startups drop them through `envToDelete` instead. */
  clearEnvNames?: readonly string[]
}

function buildAiVaultResumeStartup(
  args: AiVaultLocalResumeStartupArgs,
  buildResumePlan: typeof buildAgentResumeStartupPlan
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
  const shellOptions = {
    cwd,
    platform,
    codexHome,
    shell: liveShell,
    clearEnvNames
  }
  const startupCwd = !embedCwd && session.cwd ? { cwd: session.cwd } : {}
  if (isAntigravityReferenceSession(session)) {
    const reference = buildAntigravityReferenceStartup({
      session: { sessionId: session.sessionId, filePath: resumeFilePath },
      cwd,
      platform,
      shell: liveShell,
      commandOverride: args.commandOverride,
      settings,
      managedAgentCommands: args.managedAgentCommands
    })
    if (reference) {
      return { ...reference, ...startupCwd }
    }
  }
  if (localProviderSession && isResumableTuiAgent(session.agent)) {
    const startupPlan = buildResumePlan({
      agent: session.agent,
      providerSession: localProviderSession,
      cmdOverrides: resumeCommandOverrides(args),
      platform,
      agentHostPlatform: args.host.agentHostPlatform,
      shell: liveShell,
      agentArgs:
        args.agentArgs ??
        resolveTuiAgentLaunchRawArgs(
          session.agent,
          settings,
          undefined,
          resolveStartupShell(platform, liveShell)
        ),
      agentEnv: {
        ...resolveTuiAgentLaunchEnv(session.agent, settings, platform),
        ...managedDataAccountResumeEnv(session)
      },
      resumeInLaunchCwd: true,
      ...(session.agent !== 'omp' ? { resumeShell: shellOptions } : {}),
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
                commandOverride: ompResumeProgram(
                  startupPlan.launchConfig.agentCommand,
                  args,
                  platform,
                  liveShell
                ),
                ...shellOptions
              })
            : startupPlan.launchCommand,
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
      commandOverride: args.commandOverride,
      // Fallbacks also handle non-resumable agents; quote for the live Windows shell like startup plans.
      ...shellOptions
    }),
    ...startupCwd,
    ...realHomeCodexResumeEnvDeletion(session)
  }
}

/** Return null without fork support: plain resume would create a second writer on the chat's conversation. Omit providerSession because the copy owns a new ID and cold restore must not resume the source. */
export function buildAiVaultForkStartup(
  args: Omit<AiVaultResumeStartupArgs, 'managedAgentCommands'>
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
    agentHostPlatform: args.host.agentHostPlatform,
    shell: liveShell,
    agentArgs: resolveTuiAgentLaunchRawArgs(
      session.agent,
      settings,
      undefined,
      resolveStartupShell(platform, liveShell)
    ),
    agentEnv: resolveTuiAgentLaunchEnv(session.agent, settings, platform),
    resumeInLaunchCwd: true,
    resumeShell: { cwd: null, codexHome, shell: liveShell },
    fork: true
  })
  if (!plan) {
    return null
  }
  return {
    command: plan.launchCommand,
    ...(plan.env ? { env: plan.env } : {}),
    ...realHomeCodexResumeEnvDeletion(session),
    ...(session.cwd ? { cwd: session.cwd } : {}),
    launchConfig: plan.launchConfig
  }
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
      `${command} ${resolveTuiAgentLaunchRawArgs(agent, args.settings, undefined, resolveStartupShell(platform, liveShell))}`,
      resolveStartupShell(platform, liveShell)
    )
    if (!parsed.ok) {
      throw new Error('This session cannot be opened in the CLI.')
    }
    assertOpenCodeCopyUsesLocalStore(parsed.tokens.slice(1))
  }
}
