import { isCmdJPaletteQueryTooLarge } from './palette-results'
import type { Project, ProjectGroup, ProjectHostSetup, Repo } from '../../../../shared/types'
import { translate } from '@/i18n/i18n'
import {
  getProjectGroupHeaderKey,
  getProjectHeaderRevealTarget,
  type ProjectGroupingModel
} from '../sidebar/worktree-list-groups'

export type CmdJProjectGroupResult = {
  id: string
  kind: 'project-group'
  title: string
  description: string
  rowKey: string
  order: number
  keywords: string[]
}

export type CmdJProjectResult = {
  id: string
  kind: 'project'
  title: string
  description: string
  rowKey: string
  repo: Repo
  order: number
  keywords: string[]
}

export type CmdJProjectSearchResult = CmdJProjectGroupResult | CmdJProjectResult

type RankedProjectResult = {
  result: CmdJProjectSearchResult
  rule: number
  score: number
}

const PROJECT_GROUP_ALIASES = ['group', 'repo group']
const PROJECT_ALIASES = ['project', 'repo']

function normalizeQuery(value: string): string {
  let normalized = ''
  let pendingWhitespace = false
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (isCmdJPaletteWhitespace(code)) {
      pendingWhitespace = normalized.length > 0
      continue
    }
    if (pendingWhitespace) {
      normalized += ' '
      pendingWhitespace = false
    }
    normalized += value.charAt(index).toLowerCase()
  }
  return normalized
}

function isCmdJPaletteWhitespace(code: number): boolean {
  return (
    code === 32 ||
    (code >= 9 && code <= 13) ||
    code === 160 ||
    code === 5760 ||
    (code >= 8192 && code <= 8202) ||
    code === 8232 ||
    code === 8233 ||
    code === 8239 ||
    code === 8287 ||
    code === 12288 ||
    code === 65279
  )
}

function uniqueNormalized(values: readonly string[]): string[] {
  return [...new Set(values.map(normalizeQuery).filter(Boolean))]
}

function tokenize(value: string): string[] {
  return normalizeQuery(value)
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

function tokenScore(query: string, values: readonly string[]): number {
  const candidateTokens = values.flatMap(tokenize)
  if (candidateTokens.length === 0) {
    return 0
  }

  let score = 0
  for (const queryToken of tokenize(query)) {
    let best = 0
    for (const candidateToken of candidateTokens) {
      if (candidateToken === queryToken) {
        best = Math.max(best, 3)
      } else if (candidateToken.startsWith(queryToken)) {
        best = Math.max(best, 2)
      } else if (candidateToken.includes(queryToken)) {
        best = Math.max(best, 1)
      }
    }
    score += best
  }
  return score
}

function buildCmdJProjectSearchCandidates({
  projectGroups,
  repos,
  projects,
  projectHostSetups,
  renderableRepoIds
}: {
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  renderableRepoIds?: ReadonlySet<string>
}): CmdJProjectSearchResult[] {
  const projectGrouping: ProjectGroupingModel = { projects, projectHostSetups }
  const repoMap = new Map(repos.map((repo) => [repo.id, repo]))
  const candidates: CmdJProjectSearchResult[] = []

  projectGroups.forEach((group, order) => {
    candidates.push({
      id: `project-group:${group.id}`,
      kind: 'project-group',
      title: group.name,
      description: translate(
        'auto.components.cmd.j.palette.project.results.repoGroup',
        'Repo group'
      ),
      rowKey: getProjectGroupHeaderKey(group.id),
      order,
      keywords: uniqueNormalized([group.name, ...PROJECT_GROUP_ALIASES])
    })
  })

  const seenRowKeys = new Set<string>()
  repos.forEach((repo, repoIndex) => {
    if (renderableRepoIds && !renderableRepoIds.has(repo.id)) {
      return
    }
    const target = getProjectHeaderRevealTarget(repo.id, repoMap, projectGrouping)
    if (!target.repo || seenRowKeys.has(target.key)) {
      return
    }
    seenRowKeys.add(target.key)
    candidates.push({
      id: `project:${target.key}`,
      kind: 'project',
      title: target.label,
      description: translate('auto.components.cmd.j.palette.project.results.project', 'Project'),
      rowKey: target.key,
      repo: target.repo,
      order: projectGroups.length + repoIndex,
      keywords: uniqueNormalized([target.label, repo.displayName, ...PROJECT_ALIASES])
    })
  })

  return candidates
}

export function hasCmdJProjectSearchCandidates({
  projectGroups,
  repos,
  projects,
  projectHostSetups,
  renderableRepoIds
}: {
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  renderableRepoIds?: ReadonlySet<string>
}): boolean {
  return (
    buildCmdJProjectSearchCandidates({
      projectGroups,
      repos,
      projects,
      projectHostSetups,
      renderableRepoIds
    }).length > 0
  )
}

function projectRankingForCandidate(
  query: string,
  candidate: CmdJProjectSearchResult
): RankedProjectResult | null {
  const title = normalizeQuery(candidate.title)
  if (query === title) {
    return { result: candidate, rule: 1, score: 0 }
  }
  if (title.startsWith(query)) {
    return { result: candidate, rule: 2, score: 0 }
  }
  const aliasKeywords = candidate.kind === 'project-group' ? PROJECT_GROUP_ALIASES : PROJECT_ALIASES
  if (aliasKeywords.map(normalizeQuery).includes(query)) {
    return { result: candidate, rule: 3, score: 0 }
  }
  if (candidate.keywords.some((keyword) => keyword.startsWith(query))) {
    return { result: candidate, rule: 4, score: 0 }
  }
  const score = tokenScore(query, [candidate.title, ...candidate.keywords])
  return score > 0 ? { result: candidate, rule: 5, score } : null
}

function compareProjectRanked(a: RankedProjectResult, b: RankedProjectResult): number {
  if (a.rule !== b.rule) {
    return a.rule - b.rule
  }
  if (a.score !== b.score) {
    return b.score - a.score
  }
  if (a.result.order !== b.result.order) {
    return a.result.order - b.result.order
  }
  return a.result.id.localeCompare(b.result.id)
}

export function searchCmdJProjectResults({
  query,
  projectGroups,
  repos,
  projects,
  projectHostSetups,
  renderableRepoIds
}: {
  query: string
  projectGroups: readonly ProjectGroup[]
  repos: readonly Repo[]
  projects: readonly Project[]
  projectHostSetups: readonly ProjectHostSetup[]
  renderableRepoIds?: ReadonlySet<string>
}): CmdJProjectSearchResult[] {
  // Why: oversized pasted input should not force the palette to scan project,
  // repo, or group names that may include private workspace details.
  if (isCmdJPaletteQueryTooLarge(query)) {
    return []
  }
  const normalizedQuery = normalizeQuery(query)
  // Why: project/group rows sit after worktree matches, so one-character
  // searches would add broad noisy navigation targets before intent is clear.
  if (normalizedQuery.length < 2) {
    return []
  }
  return buildCmdJProjectSearchCandidates({
    projectGroups,
    repos,
    projects,
    projectHostSetups,
    renderableRepoIds
  })
    .map((candidate) => projectRankingForCandidate(normalizedQuery, candidate))
    .filter((entry): entry is RankedProjectResult => entry !== null)
    .sort(compareProjectRanked)
    .map((entry) => entry.result)
}
