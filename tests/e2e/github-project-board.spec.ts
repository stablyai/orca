import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { githubProjectIdentityKey } from '../../src/shared/github/project-identity'
import type { GitHubProjectTable } from '../../src/shared/github/project-types'
import type {
  ClearProjectItemFieldArgs,
  UpdateProjectItemFieldArgs
} from '../../src/shared/github/project-request-types'

type BoardFieldCall = UpdateProjectItemFieldArgs | ClearProjectItemFieldArgs

declare global {
  var __githubProjectBoardCalls: BoardFieldCall[] | undefined
}

const project = { owner: 'board-proof', ownerType: 'user', number: 1, host: 'github.com' } as const
const board: GitHubProjectTable = {
  project: {
    ...project,
    id: 'project',
    title: 'Board verification',
    url: 'https://github.com/users/board-proof/projects/1'
  },
  selectedView: {
    id: 'view',
    number: 1,
    name: 'Board',
    layout: 'BOARD_LAYOUT',
    filter: '',
    fields: [],
    groupByFields: [],
    sortByFields: [],
    verticalGroupByFields: [
      {
        id: 'status',
        name: 'Status',
        kind: 'single-select',
        dataType: 'SINGLE_SELECT',
        options: [
          { id: 'todo', name: 'Todo', color: 'GREEN' },
          { id: 'doing', name: 'In progress', color: 'YELLOW' },
          { id: 'done', name: 'Done', color: 'PURPLE' }
        ]
      }
    ]
  },
  rows: [
    {
      id: 'row',
      itemType: 'ISSUE',
      updatedAt: '',
      position: 0,
      content: {
        title: 'Verify a real board drop through the preload bridge',
        number: 7,
        body: null,
        url: '',
        state: 'OPEN',
        stateReason: null,
        isDraft: null,
        repository: 'board-proof/repo',
        labels: [],
        parentIssue: null,
        issueType: null,
        assignees: [{ login: 'tester', name: null, avatarUrl: null }]
      },
      fieldValuesByFieldId: {
        status: {
          kind: 'single-select',
          fieldId: 'status',
          optionId: 'todo',
          name: 'Todo',
          color: 'GREEN'
        }
      }
    }
  ],
  totalCount: 1,
  parentFieldDropped: false
}

test('board drops cross preload, settle optimistically, and roll back failures', async ({
  orcaPage,
  electronApp,
  seededRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ ipcMain }, data) => {
    const responses = {
      'gh:repoSlug': () => ({ owner: 'board-proof', repo: 'repo' }),
      'gh:listProjectViews': () => ({ ok: true, views: [data.selectedView] }),
      'gh:getProjectViewTable': () => ({ ok: true, data })
    }
    for (const [channel, handler] of Object.entries(responses)) {
      ipcMain.removeHandler(channel)
      ipcMain.handle(channel, handler)
    }
    const calls: BoardFieldCall[] = []
    globalThis.__githubProjectBoardCalls = calls
    ipcMain.removeHandler('gh:updateProjectItemField')
    ipcMain.handle('gh:updateProjectItemField', async (_event, args) => {
      calls.push(args)
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { ok: true }
    })
    ipcMain.removeHandler('gh:clearProjectItemField')
    ipcMain.handle('gh:clearProjectItemField', async (_event, args) => {
      calls.push(args)
      await new Promise((resolve) => setTimeout(resolve, 400))
      return { ok: false, error: { type: 'network_error', message: 'Board verification: offline' } }
    })
  }, board)
  await orcaPage.evaluate(
    ({ project, identity, seededRepoPath }) => {
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
                  canonicalKey: 'github.com/board-proof/repo',
                  remoteName: 'origin',
                  remoteUrl: 'https://github.com/board-proof/repo.git'
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
            lastViewByProject: { [identity]: { viewId: 'view' } }
          }
        },
        taskResumeState: { githubMode: 'project' }
      })
    },
    { project, identity: githubProjectIdentityKey(project), seededRepoPath }
  )
  await orcaPage.getByRole('button', { name: 'Tasks', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Projects', exact: true }).click()
  const todo = orcaPage.getByTestId('board-column-todo')
  const done = orcaPage.getByTestId('board-column-done')
  const empty = orcaPage.getByTestId('board-column-__empty__')
  const title = board.rows[0].content.title
  await expect(todo.getByRole('button', { name: title })).toBeVisible()
  await expect(orcaPage.getByTestId('board-column-doing')).toBeVisible()
  await orcaPage.evaluate(() => document.documentElement.classList.add('dark'))
  await orcaPage.screenshot({ path: testInfo.outputPath('board-dark.png') })

  await todo.getByRole('listitem').dragTo(done)
  await expect(done.getByRole('button', { name: title })).toBeVisible()
  await expect(todo.getByRole('button', { name: title })).toHaveCount(0)
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__githubProjectBoardCalls))
    .toEqual([
      {
        projectId: 'project',
        host: 'github.com',
        itemId: 'row',
        fieldId: 'status',
        value: { kind: 'single-select', optionId: 'done' }
      }
    ])
  await done.getByRole('listitem').dragTo(done)
  await done.getByRole('listitem').dragTo(empty)
  await expect(empty.getByRole('button', { name: title })).toBeVisible()
  await expect(orcaPage.getByText('Board verification: offline', { exact: true })).toBeVisible()
  await expect(done.getByRole('button', { name: title })).toBeVisible()
  await expect(empty.getByRole('button', { name: title })).toHaveCount(0)
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__githubProjectBoardCalls))
    .toEqual([
      {
        projectId: 'project',
        host: 'github.com',
        itemId: 'row',
        fieldId: 'status',
        value: { kind: 'single-select', optionId: 'done' }
      },
      { projectId: 'project', host: 'github.com', itemId: 'row', fieldId: 'status' }
    ])
  await orcaPage.screenshot({ path: testInfo.outputPath('board-rollback.png') })
  await orcaPage.evaluate(() => document.documentElement.classList.remove('dark'))
  await orcaPage.screenshot({ path: testInfo.outputPath('board-light.png') })
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const entry = Object.entries(store.getState().projectViewCache).find(
      ([, entry]) => entry.data?.project.id === 'project'
    )
    if (!entry?.[1].data) {
      throw new Error('Board cache missing')
    }
    const [key, cached] = entry
    const table = cached.data!
    const source = table.rows[0]
    const field = table.selectedView.verticalGroupByFields?.[0]
    if (field?.kind !== 'single-select') {
      throw new Error('Status field missing')
    }
    store.setState({
      projectViewCache: {
        [key]: {
          ...cached,
          data: {
            ...table,
            selectedView: {
              ...table.selectedView,
              verticalGroupByFields: [
                {
                  ...field,
                  options: [
                    ...field.options,
                    ...Array.from({ length: 6 }, (_, index) => ({
                      id: `extra-${index}`,
                      name: `Extra ${index}`,
                      color: 'BLUE'
                    }))
                  ]
                }
              ]
            },
            rows: [
              source,
              ...Array.from({ length: 40 }, (_, index) => ({
                ...source,
                id: `overflow-${index}`,
                position: index + 1,
                content: {
                  ...source.content,
                  title: `Overflow card ${index}`,
                  number: index + 100
                },
                fieldValuesByFieldId: {
                  status: {
                    kind: 'single-select' as const,
                    fieldId: 'status',
                    optionId: 'todo',
                    name: 'Todo',
                    color: 'GREEN'
                  }
                }
              }))
            ],
            totalCount: 41
          }
        }
      }
    })
  })
  const scroller = todo.locator('.overflow-y-auto')
  await expect
    .poll(() => scroller.evaluate((element) => element.scrollHeight > element.clientHeight))
    .toBe(true)
  await todo.getByRole('button', { name: 'Overflow card 39', exact: true }).scrollIntoViewIfNeeded()
  await expect(todo.getByRole('button', { name: 'Overflow card 39', exact: true })).toBeVisible()
  await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeGreaterThan(0)
  await orcaPage.getByTestId('board-column-extra-5').scrollIntoViewIfNeeded()
  await expect(orcaPage.getByTestId('board-column-extra-5')).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('board-scroll.png') })
})
