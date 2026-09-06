import type { AiVaultSessionDragPayload } from '@/lib/ai-vault-session-drag'
import {
  buildAiVaultResumeStartupForWorktreeAsync,
  type AiVaultResumeStartup
} from './ai-vault-resume-command'

type AiVaultDropResumeState = Parameters<
  typeof buildAiVaultResumeStartupForWorktreeAsync
>[0]['state']

/** Rebuilds a drag-drop resume startup under the account home the host substituted. */
export async function buildAiVaultDropRepinStartup(args: {
  state: AiVaultDropResumeState
  payload: Pick<
    AiVaultSessionDragPayload,
    'agent' | 'sessionId' | 'sessionCwd' | 'sessionExecutionHostId' | 'sessionFilePath'
  >
  substituteCodexHome: string
  worktreeId: string
}): Promise<AiVaultResumeStartup | null> {
  return buildAiVaultDropResumeStartup({
    state: args.state,
    payload: args.payload,
    codexHome: args.substituteCodexHome,
    worktreeId: args.worktreeId
  })
}

/** Resolves the startup a drag/drop resume should launch after preparation. */
export async function buildAiVaultDropLaunchStartup(args: {
  state: AiVaultDropResumeState
  payload: AiVaultSessionDragPayload
  useRealCodexHome: boolean
  substituteCodexHome?: string | null
  worktreeId: string
}): Promise<AiVaultResumeStartup | null> {
  if (args.useRealCodexHome) {
    return (
      (await buildAiVaultDropResumeStartup({
        state: args.state,
        payload: args.payload,
        codexHome: null,
        worktreeId: args.worktreeId
      })) ??
      args.payload.realHomeStartup ??
      null
    )
  }
  if (args.substituteCodexHome) {
    return buildAiVaultDropRepinStartup({
      state: args.state,
      payload: args.payload,
      substituteCodexHome: args.substituteCodexHome,
      worktreeId: args.worktreeId
    })
  }
  return (
    (await buildAiVaultDropResumeStartup({
      state: args.state,
      payload: args.payload,
      codexHome: args.payload.codexHome,
      worktreeId: args.worktreeId
    })) ?? args.payload
  )
}

/** Rebuilds a drag-drop resume startup with a freshly validated cwd. */
export async function buildAiVaultDropResumeStartup(args: {
  state: AiVaultDropResumeState
  payload: Pick<
    AiVaultSessionDragPayload,
    'agent' | 'sessionId' | 'sessionCwd' | 'sessionExecutionHostId' | 'sessionFilePath'
  > &
    Partial<Pick<AiVaultSessionDragPayload, 'codexHome'>>
  codexHome: string | null | undefined
  worktreeId: string
}): Promise<AiVaultResumeStartup | null> {
  if (args.payload.sessionCwd === undefined || !args.payload.sessionFilePath) {
    return null
  }
  if (args.codexHome === undefined) {
    return null
  }
  return buildAiVaultResumeStartupForWorktreeAsync({
    state: args.state,
    worktreeId: args.worktreeId,
    session: {
      agent: args.payload.agent,
      sessionId: args.payload.sessionId,
      cwd: args.payload.sessionCwd,
      codexHome: args.codexHome,
      executionHostId: args.payload.sessionExecutionHostId,
      filePath: args.payload.sessionFilePath
    },
    commandOverride: args.state.settings?.agentCmdOverrides?.[args.payload.agent]
  })
}
