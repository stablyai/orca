// The resume and fork startups a terminal opens a saved conversation with, built from the host's
// platform, shell and launch settings, so the desktop and the phone run one builder.

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
import { resolveTuiAgentLaunchArgs, resolveTuiAgentLaunchEnv } from './tui-agent-launch-defaults'
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
import type { GlobalSettings } from './global-settings-types'
import { parseWslUncPath } from './wsl-paths'

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

export type AiVaultResumeLaunchSettings = Partial<
  Pick<GlobalSettings, 'agentCmdOverrides' | 'agentDefaultArgs' | 'agentDefaultEnv'>
>

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
  // Why: WSL UNC Codex homes must be POSIX when invoking Linux commands.
  // Keep original paths unchanged for non-Linux targets.
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
      agentArgs:
        args.agentArgs ?? resolveTuiAgentLaunchArgs(session.agent, settings?.agentDefaultArgs),
      agentEnv: resolveTuiAgentLaunchEnv(session.agent, settings?.agentDefaultEnv),
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
      // Why: OMP resumes by absolute transcript path, so local rebuilds must
      // forward it too — otherwise a custom OMP_CODING_AGENT_DIR / WSL-store
      // session would resume by id against the default store and miss.
      resumeFilePath,
      cwd,
      platform,
      commandOverride: args.commandOverride,
      codexHome,
      // Why: non-resumable agents queue through this fallback too, so it must
      // quote for the live Windows shell like the startup-plan branch above.
      shell: liveShell,
      clearEnvNames
    }),
    ...startupCwd,
    ...realHomeCodexResumeEnvDeletion(session)
  }
}

/**
 * A terminal session that starts from a copy of a conversation a native chat owns.
 *
 * Null when the agent cannot fork: a plain resume in its place would make the terminal a second
 * writer on the chat's conversation. No `providerSession` either: the copy gets its own id, and a
 * cold restore of this tab must never re-enter the chat's conversation.
 */
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
    agentArgs: resolveTuiAgentLaunchArgs(session.agent, settings?.agentDefaultArgs),
    agentEnv: resolveTuiAgentLaunchEnv(session.agent, settings?.agentDefaultEnv),
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
    ? resolveTuiAgentLaunchArgs(session.agent, settings?.agentDefaultArgs)
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

/** OpenCode copies are written to the local store, so the launch must not point elsewhere. */
export function assertAiVaultCopiedSessionStoreAllowed(args: AiVaultResumeStartupArgs): void {
  if (args.session.agent !== 'opencode' && args.session.agent !== 'opencode2') {
    return
  }
  const { platform, liveShell } = args.host
  const command =
    args.commandOverride?.trim() ||
    args.settings?.agentCmdOverrides?.opencode ||
    getTuiAgentLaunchCommand(TUI_AGENT_CONFIG.opencode, platform)
  const parsed = tokenizeStartupCommand(
    `${command} ${resolveTuiAgentLaunchArgs('opencode', args.settings?.agentDefaultArgs)}`,
    resolveStartupShell(platform, liveShell)
  )
  if (!parsed.ok) {
    throw new Error('This session cannot be opened in the CLI.')
  }
  assertOpenCodeCopyUsesLocalStore(parsed.tokens.slice(1))
}
