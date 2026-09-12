import { isCmdJPaletteQueryTooLarge } from './palette-results'
import {
  cmdJPaletteTokenScore,
  isCmdJPaletteQueryOverTokenLimit,
  uniqueCmdJPaletteQueryTokens,
  normalizeCmdJPaletteQuery,
  uniqueNormalizedCmdJPaletteKeywords
} from './palette-query-tokens'
import type { PaletteResultQualityClass } from '@/lib/palette-match/match-quality'
import type { ProjectGroup } from '../../../../shared/project-group-types'
import type { Project, ProjectHostSetup } from '../../../../shared/project-types'
import type { Repo } from '../../../../shared/repo-types'
import { translate } from '@/i18n/i18n'
import { getProjectGroupHeaderKey } from '../sidebar/worktree-list/grouping/group-keys'
import { getProjectHeaderRevealTarget } from '../sidebar/worktree-list/grouping/project-grouping'
import type { ProjectGroupingModel } from '../sidebar/worktree-list/grouping/project-grouping'

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

/** Ranked row plus the cross-section class that decides which palette section leads. */
export type CmdJRankedProjectSearchResult = CmdJProjectSearchResult & {
  qualityClass: PaletteResultQualityClass
}

type RankedProjectResult = {
  result: CmdJProjectSearchResult
  rule: number
  score: number
}

/**
 * Only rule 1 (query equals this row's own title) is a decisive intent. Rule 3 is
 * equality against a generic alias like `repo`, which every project shares, so it
 * must not let the whole section claim leadership over a named entity hit.
 */
function projectRuleQualityClass(rule: number): PaletteResultQualityClass {
  if (rule === 1) {
    return 'exact-intent'
  }
  return rule <= 4 ? 'visible-prefix' : 'partial-evidence'
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
  queryTokens: readonly string[],
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
  const score = cmdJPaletteTokenScore(queryTokens, [candidate.title, ...candidate.keywords])
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
}): CmdJRankedProjectSearchResult[] {
  // Why: oversized pasted input should not force the palette to scan project,
  // repo, or group names that may include private workspace details.
  if (isCmdJPaletteQueryTooLarge(query)) {
    return []
  }
  const normalizedQuery = normalizeCmdJPaletteQuery(query)
  // Why: project/group rows sit after worktree matches, so one-character
  // searches would add broad noisy navigation targets before intent is clear.
  if (normalizedQuery.length < 2 || isCmdJPaletteQueryOverTokenLimit(normalizedQuery)) {
    return []
  }
  const queryTokens = uniqueCmdJPaletteQueryTokens(normalizedQuery)
  return buildCmdJProjectSearchCandidates({
    projectGroups,
    repos,
    projects,
    projectHostSetups,
    renderableRepoIds
  })
    .map((candidate) => projectRankingForCandidate(normalizedQuery, queryTokens, candidate))
    .filter((entry): entry is RankedProjectResult => entry !== null)
    .sort(compareProjectRanked)
    .map((entry) => ({ ...entry.result, qualityClass: projectRuleQualityClass(entry.rule) }))
}
