import type { ExecutionHostId } from './execution-host'
import {
  normalizeRuntimePathForComparison,
  normalizeRuntimePathSeparators
} from './cross-platform-path'
import type { AiVaultAgent, AiVaultGroup, AiVaultSession } from './ai-vault-types'
import { aiVaultAgentLabel } from './ai-vault-types'

// Why: the plain project descriptor lives with grouping so /shared filter and
// index code can share it without importing renderer project-resolution.
export type AiVaultSessionProject = {
  kind: 'repo' | 'folder' | 'unknown'
  key: string
  label: string
  projectId?: string
  repoId?: string
  hostKey?: ExecutionHostId
}

export type AiVaultSessionGroup = {
  key: string
  label: string
  sessions: AiVaultSession[]
}

export function groupAiVaultSessions(
  sessions: readonly AiVaultSession[],
  group: AiVaultGroup,
  options: {
    sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
    projectLabelByKey?: ReadonlyMap<string, string>
  } = {}
): AiVaultSessionGroup[] {
  const groups = new Map<string, AiVaultSessionGroup>()

  for (const session of sessions) {
    const { key, label } = getGroupIdentity(session, group, options)
    const existing = groups.get(key)
    if (existing) {
      existing.sessions.push(session)
    } else {
      groups.set(key, { key, label, sessions: [session] })
    }
  }

  return [...groups.values()]
}

export function folderLabel(pathValue: string | null): string {
  if (!pathValue) {
    return 'Unknown location'
  }
  // NFC so one folder renders the same header whichever spelling (macOS NFD vs
  // agent-recorded NFC) reaches the group first.
  const parts = normalizeRuntimePathSeparators(pathValue.normalize('NFC'))
    .split('/')
    .filter(Boolean)
  if (parts.length >= 2) {
    return parts.slice(-2).join('/')
  }
  return parts[0] ?? pathValue
}

/**
 * Why comparison-normalized: cwd is copied verbatim out of agent transcripts, so
 * one folder arrives with and without a trailing slash and in both NFD/NFC — each
 * spelling otherwise became its own group under an identical `folderLabel`. Also
 * avoids blanket lowercasing, which merged distinct case-sensitive POSIX folders.
 * The `folder:` prefix matches the folder project key so project grouping and its
 * fallback agree.
 */
export function folderGroupKey(pathValue: string | null): string {
  return pathValue ? `folder:${normalizeRuntimePathForComparison(pathValue)}` : 'unknown'
}

export function agentLabel(agent: AiVaultAgent): string {
  return aiVaultAgentLabel(agent)
}

function getGroupIdentity(
  session: AiVaultSession,
  group: AiVaultGroup,
  options: {
    sessionProjectById?: ReadonlyMap<string, AiVaultSessionProject>
    projectLabelByKey?: ReadonlyMap<string, string>
  }
): Pick<AiVaultSessionGroup, 'key' | 'label'> {
  if (group === 'agent') {
    return { key: session.agent, label: agentLabel(session.agent) }
  }
  if (group === 'project') {
    const sessionProject = options.sessionProjectById?.get(session.id)
    if (sessionProject) {
      return {
        key: sessionProject.key,
        label:
          options.projectLabelByKey?.get(sessionProject.key) ||
          sessionProject.label ||
          folderLabel(session.cwd)
      }
    }
  }
  return { key: folderGroupKey(session.cwd), label: folderLabel(session.cwd) }
}
