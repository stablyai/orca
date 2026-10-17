import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { githubProjectIdentityKey } from '../../../src/shared/github/project-identity'
import type { GitHubProjectTable } from '../../../src/shared/github/project-types'

/**
 * Serves `table` from stubbed `gh:` IPC handlers, points the seeded repo's
 * remote at `repository` so its rows stay visible, and opens Tasks → Projects.
 * Mutation handlers stay with each spec, since that is what they assert on.
 */
export async function openStubbedGitHubProjectView(
  {
    orcaPage,
    electronApp,
    seededRepoPath
  }: { orcaPage: Page; electronApp: ElectronApplication; seededRepoPath: string },
  table: GitHubProjectTable,
  repository: { owner: string; repo: string }
): Promise<void> {
  const project = {
    owner: table.project.owner,
    ownerType: table.project.ownerType,
    number: table.project.number,
    host: table.project.host ?? 'github.com'
  }
  await electronApp.evaluate(
    ({ ipcMain }, { data, repository }) => {
      const responses = {
        'gh:repoSlug': () => repository,
        'gh:listProjectViews': () => ({ ok: true, views: [data.selectedView] }),
        'gh:getProjectViewTable': () => ({ ok: true, data })
      }
      for (const [channel, handler] of Object.entries(responses)) {
        ipcMain.removeHandler(channel)
        ipcMain.handle(channel, handler)
      }
    },
    { data: table, repository }
  )
  await orcaPage.evaluate(
    ({ project, identity, seededRepoPath, viewId, slug }) => {
      const store = window.__store!
      const state = store.getState()
      const repo = state.repos.find((candidate) => candidate.path === seededRepoPath)
      if (!repo || !state.settings) {
        throw new Error('Seeded repository/settings missing')
      }
      store.setState({
        repos: state.repos.map((candidate) =>
          candidate.id === repo.id
            ? {
                ...candidate,
                gitRemoteIdentity: {
                  canonicalKey: `github.com/${slug}`,
                  remoteName: 'origin',
                  remoteUrl: `https://github.com/${slug}.git`
                }
              }
            : candidate
        ),
        settings: {
          ...state.settings,
          defaultTaskSource: 'github',
          defaultRepoSelection: [repo.id],
          githubProjects: {
            pinned: [],
            recent: [],
            activeProject: project,
            lastViewByProject: { [identity]: { viewId } }
          }
        },
        taskResumeState: { githubMode: 'project' }
      })
    },
    {
      project,
      identity: githubProjectIdentityKey(project),
      seededRepoPath,
      viewId: table.selectedView.id,
      slug: `${repository.owner}/${repository.repo}`
    }
  )
  await orcaPage.getByRole('button', { name: 'Tasks', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Projects', exact: true }).click()
}
