import type { AgentSessionContinuationRequest } from '@/lib/agent-session-continuation'
import type { AiVaultSession } from '../../../../shared/ai-vault-types'
import { normalizeRuntimePathForComparison } from '../../../../shared/cross-platform-path'

export function canContinueAiVaultSessionInNewSession(
  session: AiVaultSession,
  targetWorktreeId: string | null | undefined
): boolean {
  return Boolean(
    targetWorktreeId &&
    (session.filePath.trim() || session.previewMessages.some((message) => message.text.trim()))
  )
}

export function prepareAiVaultSessionContinuation(args: {
  session: AiVaultSession
  targetWorktreeId: string
  targetWorkspacePath: string
}): AgentSessionContinuationRequest {
  const { session, targetWorktreeId, targetWorkspacePath } = args
  return {
    source: {
      capturedText: previewTranscript(session),
      sourceAgent: session.agent,
      sourceTitle: session.title,
      sourceWorkingDirectory: session.cwd,
      transcriptPath: session.filePath.trim() || null,
      // Why: preview user entries can be tool results or injected skill text; only provider-authenticated prompts are safe hints.
      lastPrompt: session.lastUserPrompt ?? null,
      lastAssistantMessage: latestAssistantPreview(session)
    },
    worktreeId: targetWorktreeId,
    workspacePath: targetWorkspacePath,
    // Why: sessions can outlive their worktree selection, but continuation should preserve their recorded cwd.
    initialCwd: continuationCwd(session, targetWorkspacePath),
    launchSource: 'sidebar'
  }
}

// Why: an agent reads <cwd>/.codex or <cwd>/.claude as a *project* config. Starting a continuation
// in the directory that holds the user's own one downgrades it to project scope, which silently
// drops user-level keys and re-gates already-trusted hooks, so the worktree is the safer start.
function continuationCwd(session: AiVaultSession, targetWorkspacePath: string): string {
  const recorded = session.cwd
  if (!recorded) {
    return targetWorkspacePath
  }
  return shadowsAgentConfigRoot(recorded, session) ? targetWorkspacePath : recorded
}

// Why: the agent looks for these names inside the cwd whatever its home is set to, so only a
// config root actually named one of them can be shadowed by the directory above it.
const AGENT_CONFIG_DIRECTORY_NAMES = new Set(['.codex', '.claude'])

function shadowsAgentConfigRoot(cwd: string, session: AiVaultSession): boolean {
  const configRootParent = agentConfigRootParent(session)
  return configRootParent !== null && configRootParent === normalizeRuntimePathForComparison(cwd)
}

// Why: `codexHome` names the config root outright where a transcript path only implies it, so a
// declared home is answered from alone - falling back would let an unrelated `.codex` segment in
// the transcript speak for a home that named none.
function agentConfigRootParent(session: AiVaultSession): string | null {
  return session.codexHome?.trim()
    ? configRootParent(session.codexHome)
    : configRootParentFromTranscript(session.filePath)
}

function configRootParent(configRoot: string): string | null {
  const segments = normalizeRuntimePathForComparison(configRoot).split('/')
  const name = segments.at(-1)
  return name && AGENT_CONFIG_DIRECTORY_NAMES.has(name) ? segments.slice(0, -1).join('/') : null
}

function configRootParentFromTranscript(transcriptPath: string): string | null {
  const segments = normalizeRuntimePathForComparison(transcriptPath).split('/')
  const configIndex = segments.findIndex((segment) => AGENT_CONFIG_DIRECTORY_NAMES.has(segment))
  return configIndex > 0 ? segments.slice(0, configIndex).join('/') : null
}

function latestAssistantPreview(session: AiVaultSession): string | null {
  return session.previewMessages.findLast((message) => message.role === 'assistant')?.text ?? null
}

function previewTranscript(session: AiVaultSession): string {
  return session.previewMessages
    .filter((message) => message.text.trim())
    .map((message) => `${message.role}: ${message.text.trim()}`)
    .join('\n\n')
}
