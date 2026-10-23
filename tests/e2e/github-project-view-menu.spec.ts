import type { Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForSessionReady } from './helpers/store'
import { openStubbedGitHubProjectView } from './helpers/github-project-view'
import type {
  GitHubProjectField,
  GitHubProjectFieldValue,
  GitHubProjectRow,
  GitHubProjectTable
} from '../../src/shared/github/project-types'
import type { UpdateProjectItemFieldArgs } from '../../src/shared/github/project-request-types'

declare global {
  var __githubProjectViewMenuCalls: UpdateProjectItemFieldArgs[] | undefined
}

const TITLE: GitHubProjectField = { kind: 'field', id: 'title', name: 'Title', dataType: 'TITLE' }
const ASSIGNEES: GitHubProjectField = {
  kind: 'field',
  id: 'assignees',
  name: 'Assignees',
  dataType: 'ASSIGNEES'
}
const STATUS: GitHubProjectField = {
  kind: 'single-select',
  id: 'status',
  name: 'Status',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'todo', name: 'Todo', color: 'GREEN' },
    { id: 'doing', name: 'In progress', color: 'YELLOW' },
    { id: 'done', name: 'Done', color: 'PURPLE' }
  ]
}
const PRIORITY: GitHubProjectField = {
  kind: 'single-select',
  id: 'priority',
  name: 'Priority',
  dataType: 'SINGLE_SELECT',
  options: [
    { id: 'high', name: 'High', color: 'RED' },
    { id: 'low', name: 'Low', color: 'GRAY' }
  ]
}
const SPRINT: GitHubProjectField = {
  kind: 'iteration',
  id: 'sprint',
  name: 'Sprint',
  dataType: 'ITERATION',
  iterations: [
    { id: 'sprint-41', title: 'Sprint 41', startDate: '2026-09-28', duration: 14, completed: true },
    { id: 'sprint-42', title: 'Sprint 42', startDate: '2026-10-12', duration: 14, completed: false }
  ]
}

function issue(
  number: number,
  title: string,
  status: string,
  priority: string | null,
  sprint: string,
  assignee: string | null
): GitHubProjectRow {
  const statusOptions = STATUS.kind === 'single-select' ? STATUS.options : []
  const priorityOptions = PRIORITY.kind === 'single-select' ? PRIORITY.options : []
  const iterations = SPRINT.kind === 'iteration' ? SPRINT.iterations : []
  const iteration = iterations.find((candidate) => candidate.id === sprint)!
  const values: GitHubProjectFieldValue[] = [
    {
      kind: 'single-select',
      fieldId: 'status',
      optionId: status,
      name: statusOptions.find((option) => option.id === status)!.name,
      color: statusOptions.find((option) => option.id === status)!.color
    },
    {
      kind: 'iteration',
      fieldId: 'sprint',
      iterationId: iteration.id,
      title: iteration.title,
      startDate: iteration.startDate,
      duration: iteration.duration
    }
  ]
  if (priority) {
    const option = priorityOptions.find((candidate) => candidate.id === priority)!
    values.push({
      kind: 'single-select',
      fieldId: 'priority',
      optionId: option.id,
      name: option.name,
      color: option.color
    })
  }
  return {
    id: `item-${number}`,
    itemType: 'ISSUE',
    updatedAt: '',
    position: number,
    content: {
      title,
      number,
      body: null,
      url: '',
      state: 'OPEN',
      stateReason: null,
      isDraft: null,
      repository: 'view-proof/repo',
      labels: [],
      parentIssue: null,
      issueType: null,
      assignees: assignee ? [{ login: assignee, name: null, avatarUrl: null }] : []
    },
    fieldValuesByFieldId: Object.fromEntries(values.map((value) => [value.fieldId, value]))
  }
}

async function setTheme(page: Page, theme: 'dark' | 'light'): Promise<void> {
  await page.evaluate(async (dark) => {
    document.documentElement.classList.toggle('dark', dark)
    // Let theme transitions settle so the proof screenshots show one theme.
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation instanceof CSSTransition)
        .map((animation) => animation.finished.catch(() => undefined))
    )
  }, theme === 'dark')
}

const table: GitHubProjectTable = {
  project: {
    id: 'project',
    host: 'github.com',
    owner: 'view-proof',
    ownerType: 'user',
    number: 1,
    title: 'View menu verification',
    url: 'https://github.com/users/view-proof/projects/1'
  },
  // GitHub only returns a view's visible fields; Priority and Sprint arrive project-level.
  selectedView: {
    id: 'view',
    number: 1,
    name: 'Board',
    layout: 'BOARD_LAYOUT',
    filter: '',
    fields: [TITLE, ASSIGNEES, STATUS],
    groupByFields: [],
    sortByFields: [],
    verticalGroupByFields: [STATUS]
  },
  projectFields: [TITLE, ASSIGNEES, STATUS, PRIORITY, SPRINT],
  rows: [
    issue(1, 'Retry failed webhook deliveries', 'todo', 'high', 'sprint-42', 'ana'),
    issue(2, 'Add CSV export to reports', 'todo', 'low', 'sprint-42', 'bo'),
    issue(3, 'Rotate signing keys', 'doing', 'high', 'sprint-41', 'ana'),
    issue(4, 'Document the billing API', 'doing', 'low', 'sprint-42', null),
    issue(5, 'Fix flaky login test', 'done', 'high', 'sprint-41', 'bo'),
    issue(6, 'Cache avatar images', 'done', null, 'sprint-41', null)
  ],
  totalCount: 6,
  parentFieldDropped: false
}

test('the View menu regroups a board locally and writes both fields on a cross-lane drop', async ({
  orcaPage,
  electronApp,
  seededRepoPath
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  await electronApp.evaluate(({ ipcMain }) => {
    const calls: UpdateProjectItemFieldArgs[] = []
    globalThis.__githubProjectViewMenuCalls = calls
    ipcMain.removeHandler('gh:updateProjectItemField')
    ipcMain.handle('gh:updateProjectItemField', (_event, args) => {
      calls.push(args)
      return { ok: true }
    })
  })
  await openStubbedGitHubProjectView({ orcaPage, electronApp, seededRepoPath }, table, {
    owner: 'view-proof',
    repo: 'repo'
  })
  await setTheme(orcaPage, 'dark')
  const todo = orcaPage.getByTestId('board-column-todo')
  await expect(todo.getByRole('button', { name: 'Add CSV export to reports' })).toBeVisible()
  await orcaPage.screenshot({ path: testInfo.outputPath('view-menu-default.png') })

  // The accessible name gains "(changed in Orca)" once any override is active.
  const viewButton = orcaPage.getByRole('button', { name: /^View options/ })
  await expect(viewButton).toHaveAccessibleName('View options')
  await viewButton.click()
  await orcaPage.getByRole('menuitem', { name: /^Swimlanes:/ }).click()
  await expect(orcaPage.getByRole('menuitemradio', { name: 'Priority' })).toBeVisible()
  // Sprint is hidden from the GitHub view but still offered, from the project's field list.
  await expect(orcaPage.getByRole('menuitemradio', { name: 'Sprint' })).toBeVisible()
  // Let the submenu's open animation finish so the proof screenshot shows it.
  await orcaPage
    .locator('[data-slot="dropdown-menu-sub-content"]')
    .evaluate((element) =>
      Promise.all(element.getAnimations().map((animation) => animation.finished))
    )
  await orcaPage.screenshot({ path: testInfo.outputPath('view-menu-open.png') })
  await orcaPage.getByRole('menuitemradio', { name: 'Priority' }).click()

  const highTodo = orcaPage.getByTestId('board-cell-high-todo')
  const lowTodo = orcaPage.getByTestId('board-cell-low-todo')
  await expect(
    highTodo.getByRole('button', { name: 'Retry failed webhook deliveries' })
  ).toBeVisible()
  await expect(lowTodo.getByRole('button', { name: 'Add CSV export to reports' })).toBeVisible()
  await expect(orcaPage.getByTestId('board-lane-__empty__')).toContainText('No Priority')
  await expect(viewButton).toHaveAccessibleName('View options (changed in Orca)')

  await viewButton.click()
  await orcaPage.getByRole('menuitem', { name: /^Fields:/ }).click()
  await orcaPage.getByRole('menuitemcheckbox', { name: 'Sprint' }).click()
  // Field toggles keep the menu open so several can be flipped in a row.
  await expect(orcaPage.getByRole('menuitemcheckbox', { name: 'Sprint' })).toBeChecked()
  await orcaPage.keyboard.press('Escape')
  await expect(orcaPage.getByRole('menu')).toHaveCount(0)
  await expect(highTodo.getByRole('listitem').first()).toContainText('Sprint 42')
  await orcaPage.screenshot({ path: testInfo.outputPath('view-menu-swimlanes.png') })
  await setTheme(orcaPage, 'light')
  await orcaPage.screenshot({ path: testInfo.outputPath('view-menu-swimlanes-light.png') })
  await setTheme(orcaPage, 'dark')

  await lowTodo
    .getByRole('listitem', { name: '#2 — Add CSV export to reports' })
    .dragTo(orcaPage.getByTestId('board-cell-high-doing'))
  await expect(
    orcaPage.getByTestId('board-cell-high-doing').getByRole('button', {
      name: 'Add CSV export to reports'
    })
  ).toBeVisible()
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__githubProjectViewMenuCalls))
    .toEqual([
      {
        projectId: 'project',
        host: 'github.com',
        itemId: 'item-2',
        fieldId: 'status',
        value: { kind: 'single-select', optionId: 'doing' }
      },
      {
        projectId: 'project',
        host: 'github.com',
        itemId: 'item-2',
        fieldId: 'priority',
        value: { kind: 'single-select', optionId: 'high' }
      }
    ])

  await viewButton.click()
  await orcaPage.getByRole('menuitem', { name: /^Column by:/ }).click()
  await orcaPage.getByRole('menuitemradio', { name: 'Sprint' }).click()
  await expect(orcaPage.getByTestId('board-cell-high-sprint-42')).toContainText(
    'Retry failed webhook deliveries'
  )
  await expect(orcaPage.getByTestId('board-cell-high-todo')).toHaveCount(0)

  await viewButton.click()
  await orcaPage.getByRole('menuitem', { name: 'Reset to the GitHub view' }).click()
  await expect(todo.getByRole('button', { name: 'Retry failed webhook deliveries' })).toBeVisible()
  await expect(orcaPage.getByTestId('board-lane-high')).toHaveCount(0)
  await expect(viewButton).toHaveAccessibleName('View options')
})
