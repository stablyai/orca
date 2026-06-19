import type { AgentCatalogEntry } from '@/lib/agent-catalog'

type RankedAgent = {
  agent: AgentCatalogEntry
  score: number
  index: number
}

const NO_MATCH = Number.POSITIVE_INFINITY

export function getAgentPickerCommandValue({
  blankValue,
  blankMatchesQuery,
  currentValue,
  filteredAgents,
  rawQuery
}: {
  blankValue: string
  blankMatchesQuery: boolean
  currentValue: AgentCatalogEntry['id'] | null
  filteredAgents: readonly AgentCatalogEntry[]
  rawQuery: string
}): string {
  if (!normalizeSearchText(rawQuery)) {
    return currentValue ?? blankValue
  }
  if (blankMatchesQuery) {
    return blankValue
  }
  return filteredAgents[0]?.id ?? ''
}

export function searchAgentPickerEntries(
  agents: readonly AgentCatalogEntry[],
  rawQuery: string
): AgentCatalogEntry[] {
  const query = normalizeSearchText(rawQuery)
  if (!query) {
    return [...agents]
  }

  const matches: RankedAgent[] = []
  agents.forEach((agent, index) => {
    const score = scoreAgent(agent, query)
    if (score !== NO_MATCH) {
      matches.push({ agent, score, index })
    }
  })

  matches.sort((a, b) => a.score - b.score || a.index - b.index)
  return matches.map((m) => m.agent)
}

export function agentPickerBlankTerminalMatches(rawQuery: string): boolean {
  const query = normalizeSearchText(rawQuery)
  if (!query) {
    return true
  }

  return (
    scoreCandidate(query, 'Blank Terminal', 0) !== NO_MATCH ||
    scoreCandidate(query, 'terminal', 0) !== NO_MATCH ||
    scoreCandidate(query, 'shell', 0) !== NO_MATCH
  )
}

function scoreAgent(agent: AgentCatalogEntry, query: string): number {
  return Math.min(
    scoreCandidate(query, agent.label, 0),
    scoreCandidate(query, agent.id, 600),
    scoreCandidate(query, agent.cmd, 650)
  )
}

function scoreCandidate(query: string, rawCandidate: string, baseScore: number): number {
  const candidate = normalizeSearchText(rawCandidate)
  if (!candidate) {
    return NO_MATCH
  }

  if (candidate === query) {
    return baseScore
  }
  if (candidate.startsWith(query)) {
    return baseScore + 10
  }

  const substringIndex = candidate.indexOf(query)
  if (substringIndex !== -1) {
    return baseScore + 100 + substringIndex
  }

  const acronymScore = scoreAcronymQuery(query, rawCandidate)
  if (acronymScore !== NO_MATCH) {
    return baseScore + 220 + acronymScore
  }

  const fuzzyScore = scoreFuzzyQuery(query, candidate)
  if (fuzzyScore !== NO_MATCH) {
    return baseScore + 400 + fuzzyScore
  }

  return NO_MATCH
}

function scoreAcronymQuery(query: string, rawCandidate: string): number {
  const acronym = buildAcronym(rawCandidate)
  if (!acronym) {
    return NO_MATCH
  }
  if (acronym === query) {
    return 0
  }
  if (acronym.startsWith(query)) {
    return 10
  }
  return scoreFuzzyQuery(query, acronym)
}

function buildAcronym(value: string): string {
  const chars: string[] = []
  let previous = ''

  for (const char of value) {
    if (!/[a-z0-9]/i.test(char)) {
      previous = char
      continue
    }

    if (
      chars.length === 0 ||
      !/[a-z0-9]/i.test(previous) ||
      (/[a-z]/.test(previous) && /[A-Z]/.test(char))
    ) {
      chars.push(char.toLowerCase())
    }
    previous = char
  }

  return chars.join('')
}

function scoreFuzzyQuery(query: string, candidate: string): number {
  let queryIndex = 0
  let score = 0
  let lastMatchIndex = -1

  for (
    let candidateIndex = 0;
    candidateIndex < candidate.length && queryIndex < query.length;
    candidateIndex++
  ) {
    if (candidate[candidateIndex] !== query[queryIndex]) {
      continue
    }

    const gap = lastMatchIndex === -1 ? candidateIndex : candidateIndex - lastMatchIndex - 1
    score += gap
    if (isBoundary(candidate, candidateIndex)) {
      score -= 4
    }
    lastMatchIndex = candidateIndex
    queryIndex++
  }

  if (queryIndex < query.length) {
    return NO_MATCH
  }

  return score
}

function isBoundary(value: string, index: number): boolean {
  if (index === 0) {
    return true
  }
  return value[index - 1] === ' ' || value[index - 1] === '-' || value[index - 1] === '_'
}

function normalizeSearchText(value: string): string {
  return value.trim().toLowerCase().replace(/\s+/g, ' ')
}
