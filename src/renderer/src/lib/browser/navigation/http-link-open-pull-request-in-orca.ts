import { toast } from 'sonner'
import { findMatchingRepoForSlug } from '@/components/new-workspace/source-search/smart-workspace-repo-slug'
import { translate } from '@/i18n/i18n'
import { parseGitHubIssueOrPRLink } from '../../../../../shared/github/repositories/links'
import { lookupGitHubWorkItemByOwnerRepoForSource } from '@/lib/work-items/github/github-work-item-source-lookup'
import { useAppStore } from '@/store'
import { buildTaskSourceContextFromRepo } from '../../../../../shared/work-items/task-source-context'

export function isGitHubPullRequestUrl(url: string | undefined): boolean {
  return url !== undefined && parseGitHubIssueOrPRLink(url)?.type === 'pr'
}

export async function openGitHubPullRequestUrlInOrca(url: string): Promise<void> {
  const link = parseGitHubIssueOrPRLink(url)
  if (link?.type !== 'pr') {
    return
  }
  const state = useAppStore.getState()
  const target = await findMatchingRepoForSlug(
    state.repos.map((repo) => ({
      repo,
      sourceContext: buildTaskSourceContextFromRepo({
        provider: 'github',
        projectId: repo.id,
        repo
      })
    })),
    link.slug,
    new Map()
  )
  if (!target) {
    toast.error(
      translate(
        'auto.lib.browser.navigation.httpLinkOpenPullRequestInOrca.noProject',
        'No project in Orca matches this pull request.'
      )
    )
    return
  }
  const item = await lookupGitHubWorkItemByOwnerRepoForSource({
    repoPath: target.repo.path,
    repoId: target.repo.id,
    sourceContext: target.sourceContext,
    owner: link.slug.owner,
    repo: link.slug.repo,
    ...(link.slug.host ? { host: link.slug.host } : {}),
    number: link.number,
    type: 'pr'
  }).catch(() => null)
  if (!item) {
    toast.error(
      translate(
        'auto.lib.browser.navigation.httpLinkOpenPullRequestInOrca.loadFailed',
        'Unable to load this pull request.'
      )
    )
    return
  }
  state.openTaskPage({
    taskSource: 'github',
    preselectedRepoId: target.repo.id,
    openGitHubWorkItem: { ...item, repoId: target.repo.id }
  })
}
