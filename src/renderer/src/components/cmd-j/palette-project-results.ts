import { isCmdJPaletteQueryTooLarge } from './palette-results'
import {
  cmdJPaletteTokenScore,
  normalizeCmdJPaletteQuery,
  uniqueNormalizedCmdJPaletteKeywords
} from './palette-query-tokens'
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
      keywords: uniqueNormalizedCmdJPaletteKeywords([group.name, ...PROJECT_GROUP_ALIASES])
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
      keywords: uniqueNormalizedCmdJPaletteKeywords([
        target.label,
        repo.displayName,
        ...PROJECT_ALIASES
      ])
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
  const title = normalizeCmdJPaletteQuery(candidate.title)
  if (query === title) {
    return { result: candidate, rule: 1, score: 0 }
  }
  if (title.startsWith(query)) {
    return { result: candidate, rule: 2, score: 0 }
  }
  const aliasKeywords = candidate.kind === 'project-group' ? PROJECT_GROUP_ALIASES : PROJECT_ALIASES
  if (aliasKeywords.map(normalizeCmdJPaletteQuery).includes(query)) {
    return { result: candidate, rule: 3, score: 0 }
  }
  if (candidate.keywords.some((keyword) => keyword.startsWith(query))) {
    return { result: candidate, rule: 4, score: 0 }
  }
  const score = cmdJPaletteTokenScore(query, [candidate.title, ...candidate.keywords])
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
  const normalizedQuery = normalizeCmdJPaletteQuery(query)
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
