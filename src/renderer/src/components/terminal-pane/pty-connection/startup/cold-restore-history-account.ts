import { isLegacySharedCodexHome } from '../../../../../../shared/ai-vault/resume/ai-vault-resume-preparation'
import { isWslUncPath } from '../../../../../../shared/file-access/wsl-paths'
import { buildAgentResumeStartupPlan } from '../../../../../../shared/agent-launch/startup/tui-agent-resume-startup'
import { prepareAiVaultTerminalResumeRequest } from '@/lib/agent-session/resume/history/ai-vault-session-resume-preparation'
import { commitHistorySessionResume } from '@/lib/agent-session/resume/history/history-resume-receipts'
import { translate } from '@/i18n/i18n'
import type { ColdRestoreAgentResumeStartup, FreshSpawnOptions } from './fresh-spawn-types'
import type { ConnectPanePtySession } from '../connect-pane-pty-session'
import { runPaneResumeAttempt } from './in-place-resume-hold'
import { isMainResumedSleepPaneCurrent } from '../spawn/main-resumed-sleep-pane'

export function spawnColdRestoreWithAccount(
  session: ConnectPanePtySession,
  startup: ColdRestoreAgentResumeStartup | null,
  options: FreshSpawnOptions
): Promise<string | null> {
  const prepareAccount = startup?.prepareAccount
  if (!startup || !prepareAccount) {
    session.applyColdRestoreAgentResumeStartup(startup)
    return session.startFreshSpawn(startup, options)
  }
  return runPaneResumeAttempt(session, async () => {
    let prepared: ColdRestoreAgentResumeStartup
    try {
      prepared = await prepareAccount()
    } catch (error) {
      if (!(error instanceof Error && error.name === 'AbortError') && !session.disposed) {
        session.reportError(error instanceof Error ? error.message : String(error))
      }
      return null
    }
    if (!isMainResumedSleepPaneCurrent(session, startup)) {
      return null
    }
    session.applyColdRestoreAgentResumeStartup(prepared)
    const ptyId = await session.startFreshSpawn(prepared, options)
    if (ptyId) {
      await prepared.commitAccount?.()
    }
    return ptyId
  })
}

export function prepareColdRestoreHistoryAccount(
  startup: ColdRestoreAgentResumeStartup,
  args: Parameters<typeof buildAgentResumeStartupPlan>[0],
  workspaceId: string,
  executionHostId: string | null | undefined
): ColdRestoreAgentResumeStartup {
  const filePath = startup.resumeProviderSession.transcriptPath
  const home = filePath?.match(
    /^(.*)[\\/]sessions[\\/]\d{4}[\\/]\d{2}[\\/]\d{2}[\\/]rollout-[^\\/]+\.jsonl(?:\.zst)?$/
  )?.[1]
  if (
    startup.agent !== 'codex' ||
    !filePath ||
    isWslUncPath(filePath) ||
    !isLegacySharedCodexHome(home ?? null) ||
    (executionHostId && executionHostId !== 'local')
  ) {
    return startup
  }
  return {
    ...startup,
    prepareAccount: async () => {
      const prepared = await prepareAiVaultTerminalResumeRequest(
        {
          agent: 'codex',
          sessionId: startup.resumeProviderSession.id,
          filePath,
          codexHome: home ?? null,
          executionHostId: 'local'
        },
        workspaceId
      )
      if (!prepared.resumeReceipt) {
        return startup
      }
      const providerSession = {
        ...startup.resumeProviderSession,
        id: prepared.substituteSessionId ?? startup.resumeProviderSession.id,
        transcriptPath: prepared.substituteTranscriptPath ?? filePath
      }
      const plan = buildAgentResumeStartupPlan({ ...args, providerSession })
      if (!plan) {
        throw new Error(
          translate(
            'auto.components.right.sidebar.AiVaultPanel.prepareSessionResumeFailed',
            'Could not prepare this session for resume.'
          )
        )
      }
      return {
        ...startup,
        command: plan.launchCommand,
        launchConfig: plan.launchConfig,
        resumeProviderSession: providerSession,
        env: {
          ...plan.env,
          ORCA_AGENT_LAUNCH_TOKEN: startup.launchToken,
          ORCA_HISTORY_RESUME_RECEIPT: prepared.resumeReceipt
        },
        commitAccount: () =>
          commitHistorySessionResume({
            agent: 'codex',
            sessionId: providerSession.id,
            filePath: providerSession.transcriptPath,
            codexHome: prepared.substituteCodexHome ?? null,
            executionHostId: 'local',
            resumeReceipt: prepared.resumeReceipt
          })
      }
    }
  }
}
