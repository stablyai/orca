import type { AiVaultSession } from './ai-vault-types'
import { sessionPreviewSearchText } from './ai-vault-session-preview-text'
import {
  filterAiVaultSessions,
  type AiVaultSessionFilterState,
  type AiVaultSessionFilterOptions
} from './ai-vault-session-filters'
import { expandAiVaultSearchTerms } from './ai-vault-session-query'

export const AI_VAULT_SEARCH_CANDIDATE_LIMIT = 40

export type AiVaultSessionRankCard = {
  id: string
  title: string
  agent: string
  cwd: string | null
  branch: string | null
  model: string | null
  preview: string
}

export type AiVaultAiSearchResult = {
  sessions: AiVaultSession[]
  usedModel: boolean
  candidateCount: number
}

export type AiVaultSessionRerankResult = {
  rankedIds: readonly string[]
  usedModel: boolean
}

export type AiVaultSessionRerankFn = (
  query: string,
  cards: readonly AiVaultSessionRankCard[]
) => Promise<AiVaultSessionRerankResult>

export type AiVaultRankSessionsArgs = {
  query: string
  cards: readonly AiVaultSessionRankCard[]
  repoId?: string | null
}

export type AiVaultRankSessionsResult =
  | { ok: true; rankedIds: string[]; usedModel: boolean; agentLabel?: string }
  | { ok: false; error: string; usedModel: false; rankedIds: string[] }

export function toAiVaultSessionRankCard(session: AiVaultSession): AiVaultSessionRankCard {
  return {
    id: session.id,
    title: session.title,
    agent: session.agent,
    cwd: session.cwd,
    branch: session.branch,
    model: session.model,
    preview: sessionPreviewSearchText(session).slice(0, 280)
  }
}

export function buildAiVaultRerankPrompt(
  query: string,
  cards: readonly AiVaultSessionRankCard[]
): string {
  const catalog = cards
    .map((card, index) => {
      const location = card.cwd ?? 'unknown location'
      return `${index + 1}. id=${card.id}
title: ${card.title}
agent: ${card.agent}
cwd: ${location}
branch: ${card.branch ?? 'none'}
model: ${card.model ?? 'none'}
preview: ${card.preview || '(empty)'}`
    })
    .join('\n\n')

  return `Rank these coding-agent sessions for the user's search.
Return ONLY a JSON array of session ids, best match first.
Keep ids exactly as given. Omit sessions that are clearly irrelevant.
Do not explain.

Query: ${query}

Sessions:
${catalog}`
}

export function parseAiVaultRerankOutput(
  output: string,
  candidateIds: readonly string[]
): string[] {
  const allowed = new Set(candidateIds)
  const parsed = extractJsonStringArray(output)
  const ranked: string[] = []
  for (const value of parsed) {
    if (allowed.has(value) && !ranked.includes(value)) {
      ranked.push(value)
    }
  }
  if (ranked.length === 0) {
    return [...candidateIds]
  }
  for (const id of candidateIds) {
    if (!ranked.includes(id)) {
      ranked.push(id)
    }
  }
  return ranked
}

export function scoreAiVaultSessionCard(
  card: AiVaultSessionRankCard,
  terms: readonly string[]
): number {
  if (terms.length === 0) {
    return 0
  }
  const haystack =
    `${card.title} ${card.agent} ${card.cwd ?? ''} ${card.branch ?? ''} ${card.preview}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (haystack.includes(term)) {
      score += term.length >= 4 ? 2 : 1
    }
  }
  return score
}

export async function searchAiVaultSessionsWithAi(args: {
  sessions: readonly AiVaultSession[]
  filters: AiVaultSessionFilterState
  options?: AiVaultSessionFilterOptions
  rerank?: AiVaultSessionRerankFn
  candidateLimit?: number
  candidates?: readonly AiVaultSession[]
}): Promise<AiVaultAiSearchResult> {
  const expandedTerms = expandAiVaultSearchTerms(args.filters.query)
  const lexical =
    args.candidates ??
    filterAiVaultSessions(args.sessions, args.filters, {
      ...args.options,
      termMode: expandedTerms.length > 0 ? 'or' : 'and',
      queryTerms: expandedTerms.length > 0 ? expandedTerms : undefined
    })
  const scored = [...lexical].sort((left, right) => {
    const delta =
      scoreAiVaultSessionCard(toAiVaultSessionRankCard(right), expandedTerms) -
      scoreAiVaultSessionCard(toAiVaultSessionRankCard(left), expandedTerms)
    return delta !== 0 ? delta : 0
  })
  const limited = scored.slice(0, args.candidateLimit ?? AI_VAULT_SEARCH_CANDIDATE_LIMIT)
  if (!args.rerank || limited.length === 0) {
    return { sessions: scored, usedModel: false, candidateCount: limited.length }
  }

  const cards = limited.map(toAiVaultSessionRankCard)
  const ranked = await args.rerank(args.filters.query, cards)
  return {
    sessions: orderSessionsByIds(scored, ranked.rankedIds),
    usedModel: ranked.usedModel,
    candidateCount: limited.length
  }
}

function orderSessionsByIds(
  sessions: readonly AiVaultSession[],
  rankedIds: readonly string[]
): AiVaultSession[] {
  const byId = new Map(sessions.map((session) => [session.id, session]))
  const ordered: AiVaultSession[] = []
  for (const id of rankedIds) {
    const session = byId.get(id)
    if (session) {
      ordered.push(session)
      byId.delete(id)
    }
  }
  for (const session of sessions) {
    if (byId.has(session.id)) {
      ordered.push(session)
    }
  }
  return ordered
}

function extractJsonStringArray(output: string): string[] {
  const trimmed = output.trim()
  const jsonBlock = extractJsonBlock(trimmed)
  try {
    const parsed = JSON.parse(jsonBlock) as unknown
    if (Array.isArray(parsed)) {
      return parsed.filter((value): value is string => typeof value === 'string')
    }
  } catch {
    return extractBareIds(trimmed)
  }
  return extractBareIds(trimmed)
}

function extractJsonBlock(output: string): string {
  const fenced = output.match(/```(?:json)?\s*([\s\S]*?)```/i)
  if (fenced?.[1]) {
    return fenced[1].trim()
  }
  const start = output.indexOf('[')
  const end = output.lastIndexOf(']')
  if (start !== -1 && end > start) {
    return output.slice(start, end + 1)
  }
  return output
}

function extractBareIds(output: string): string[] {
  return output
    .split(/[\s,]+/)
    .map((value) => value.replace(/^["'`[]+|["'`,\]]+$/g, ''))
    .filter(Boolean)
}
