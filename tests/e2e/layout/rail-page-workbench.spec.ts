import { expect, type Page } from '@stablyai/playwright-test'
import type { ArtifactListItem } from '../../../src/shared/artifacts/artifacts'
import { waitForSessionReady } from '../desktop/renderer-probes/store'
import {
  bands,
  enter,
  rail,
  seedAutomations,
  seedSkills,
  seedTaskProviders,
  test
} from './rail-page-workbench-fixture'

const layouts = [
  { width: 1280, theme: 'light' },
  { width: 560, theme: 'dark' },
  { width: 1280, theme: 'dark' },
  { width: 560, theme: 'light' }
] as const

for (const layout of layouts) {
  const variant = `${layout.width}px ${layout.theme}`

  test(`Artifacts refresh, search and Escape at ${variant}`, async ({ orcaPage, inventory }) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => window.__store!.getState().connectCurrentOrcaProfile())
    const { header, toolbar, root } = await enter(orcaPage, 'artifacts', 'Artifacts', layout)
    const refresh = header.locator('[data-rail-page-refresh]')
    await expect(refresh).toBeEnabled()
    await expect(toolbar).toBeHidden()
    const items = Array.from({ length: 20 }, (_, index): ArtifactListItem => {
      const title = `Example document ${String(index + 1).padStart(2, '0')}`
      const slug = `example-document-${index + 1}`
      return {
        artifact: {
          version: 1,
          slug,
          title,
          originalFileName: `${slug}.html`,
          sourceContentType: 'text/html',
          renderedContentType: 'text/html',
          createdAt: '2026-01-02T00:00:00Z',
          updatedAt: '2026-01-02T00:00:00Z',
          expiresAt: '2099-01-02T00:00:00Z',
          byteSize: 128,
          deletedAt: null
        },
        shareUrl: `https://share.onorca.dev/a/${slug}`
      }
    })
    inventory.artifacts = items
    await refresh.click()
    await expect(header.locator('[data-rail-page-count]')).toHaveText('20')
    const rightEdge = async (locator: ReturnType<Page['locator']>): Promise<number> => {
      const box = await locator.boundingBox()
      if (!box) {
        throw new Error('Expected a visible action')
      }
      return box.x + box.width
    }
    const rowMenu = root.getByRole('button', { name: 'Artifact actions', exact: true }).first()
    await expect
      .poll(async () => Math.abs((await rightEdge(refresh)) - (await rightEdge(rowMenu))))
      .toBeLessThanOrEqual(2)
    const search = toolbar.getByRole('textbox', { name: 'Search artifacts' })
    if (layout.width === 560) {
      const searchButton = toolbar.getByRole('button', { name: 'Search', exact: true })
      await expect(searchButton).toBeFocused()
      await expect(searchButton).toHaveCSS('width', '28px')
      await searchButton.click()
      const field = toolbar.locator('[data-rail-page-search] [data-expanded=true]')
      await expect(field).toBeVisible()
      expect((await field.boundingBox())?.width).toBeGreaterThan(400)
    }
    await expect(search).toBeFocused()
    if (layout.width !== 560) {
      await expect(toolbar.locator('[data-rail-page-search]')).toHaveCSS('width', '204px')
    }
    await expect(toolbar).toHaveCSS('height', '42px')
    await root.locator('.scrollbar-sleek').hover()
    await orcaPage.mouse.wheel(0, 1600)
    await expect(root.getByText('Example document 20', { exact: true })).toBeInViewport()
    await search.fill('Example document 18')
    await expect(root.getByText('Example document 18', { exact: true })).toBeVisible()
    await expect(root.getByText('Example document 01', { exact: true })).toHaveCount(0)
    await orcaPage.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    await expect(search).toBeFocused()
    await orcaPage.keyboard.press('Escape')
    await expect(toolbar.locator('input')).not.toBeFocused()
    await expect(root).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(root).toBeHidden()
  })

  test(`Automations toolbar and Runs navigation at ${variant}`, async ({ orcaPage }) => {
    if (layout.width === 560) {
      await seedAutomations(orcaPage)
    }
    const { root, header, toolbar } = await enter(orcaPage, 'automations', 'Automations', layout)
    const search = toolbar.getByRole('textbox', { name: 'Search automations' })
    const searchButton = toolbar.getByRole('button', { name: 'Search', exact: true })
    await expect(layout.width === 560 ? searchButton : search).toBeVisible()
    await expect(toolbar).toHaveCSS('height', '42px')
    const newAutomation = header.getByRole('button', { name: 'New Automation' })
    await expect(newAutomation).toBeVisible()
    await expect(newAutomation).toHaveAttribute('data-contextual-tour-target', 'automations-create')
    await newAutomation.click()
    await expect(orcaPage.getByRole('dialog', { name: /create automation/i })).toBeVisible()
    await orcaPage.keyboard.press('ControlOrMeta+f')
    await expect(toolbar.locator('input')).not.toBeFocused()
    await orcaPage.keyboard.press('Escape')
    const filter = toolbar.getByRole('button', { name: 'Filters' })
    await filter.click()
    const status = orcaPage.getByRole('menuitem', { name: 'Status' })
    await expect(status).toBeVisible()
    await status.press('ArrowRight')
    await orcaPage.getByRole('menuitemradio', { name: 'Paused' }).click()
    await expect(filter).toHaveAccessibleName('Filters (1)')
    await expect(root.getByRole('button', { name: 'Remove Status filter' })).toBeVisible()
    await root.getByRole('button', { name: 'Remove Status filter' }).click()
    await orcaPage.keyboard.press('ControlOrMeta+f')
    await expect(search).toBeFocused()
    await search.fill('Example automation 18')
    if (layout.width === 560) {
      await expect(root.getByText('Example automation 18', { exact: true })).toBeVisible()
      await expect(root.getByText('Example automation 01', { exact: true })).toBeHidden()
    }
    await orcaPage.keyboard.press('Escape')
    await expect(search).toHaveValue('')
    if (layout.width === 560) {
      await orcaPage.keyboard.press('Escape')
      await expect(search).toBeHidden()
    }
    const runs = toolbar.getByRole('button', { name: 'Runs' })
    await expect(runs).toHaveAttribute('data-contextual-tour-target', 'automations-runs')
    await runs.click()
    await expect(runs).toHaveAttribute('aria-current', 'page')
    await expect(
      layout.width === 560 ? searchButton : toolbar.getByRole('textbox', { name: 'Search runs' })
    ).toBeVisible()
    await expect(header.getByRole('button', { name: 'Refresh runs' })).toBeVisible()
    await toolbar.getByRole('button', { name: 'Automations' }).click()
    await expect(layout.width === 560 ? searchButton : search).toBeVisible()
  })

  test(`Skills view switching, filters and selection at ${variant}`, async ({
    electronApp,
    orcaPage
  }, info) => {
    await seedSkills(electronApp)
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() => window.__store!.getState().connectCurrentOrcaProfile())
    const seededCount = await orcaPage.evaluate(async () => {
      const discovery = await window.api.skills.discover({ refresh: true })
      return discovery.skills.filter((skill) => skill.name.startsWith('workbench-example-')).length
    })
    expect(seededCount).toBe(20)
    const { header, toolbar, root } = await enter(orcaPage, 'skills', 'Skills', layout)
    const home = toolbar.getByRole('radio', { name: /^Home/ })
    const shared = toolbar.getByRole('radio', { name: /^Shared links/ })
    await expect(toolbar).toHaveCSS('height', '42px')
    await expect(header.getByText('This machine', { exact: true })).toBeHidden()
    await home.click()
    await expect(home).toHaveAttribute('aria-checked', 'true')
    await expect(root.getByText('workbench-example-01', { exact: true })).toBeVisible()
    await expect(root.getByText('20 results', { exact: true })).toHaveClass('sr-only')
    await expect(home).toHaveAccessibleName('Home 20')
    const firstSkill = root.getByRole('option', { name: /workbench-example-01/ })
    const rowActions = firstSkill.getByRole('button', { name: 'Actions for workbench-example-01' })
    await expect(rowActions).toBeHidden()
    await firstSkill.focus()
    await orcaPage.keyboard.press('Tab')
    await expect(rowActions).toBeFocused()
    const search = toolbar.getByRole('textbox', { name: 'Search skills' })
    const searchButton = toolbar.getByRole('button', { name: 'Search', exact: true })
    const closeSearch = toolbar.getByRole('button', { name: 'Close search' })
    if (layout.width === 560) {
      await expect(shared).toBeInViewport({ ratio: 1 })
      await searchButton.click()
      await expect(home).toBeHidden()
      await expect(closeSearch).toBeVisible()
    }
    await search.fill('workbench-example-20')
    await expect(root.getByText('workbench-example-20', { exact: true })).toBeVisible()
    await expect(root.getByText('workbench-example-01', { exact: true })).toBeHidden()
    if (layout.width === 560) {
      await closeSearch.click()
      await expect(searchButton).toBeFocused()
      await expect(search).toBeHidden()
      await expect(home).toBeVisible()
      await searchButton.click()
      await expect(search).toHaveValue('workbench-example-20')
      await closeSearch.press('Enter')
      await expect(searchButton).toBeFocused()
    }
    await home.focus()
    await orcaPage.keyboard.press('End')
    await expect(shared).toBeFocused()
    await expect(shared).toBeInViewport()
    await orcaPage.keyboard.press('Enter')
    await expect(
      layout.width === 560 ? searchButton : toolbar.getByRole('textbox', { name: 'Search links' })
    ).toBeVisible()
    await expect(toolbar.getByRole('button', { name: 'Filters' })).toBeHidden()
    await orcaPage.keyboard.press('Escape')
    await expect(home).toHaveAttribute('aria-checked', 'true')
    if (layout.width === 560) {
      await searchButton.click()
      await expect(search).toHaveValue('')
      await closeSearch.click()
    } else {
      await expect(search).toHaveValue('')
    }
    await toolbar.getByRole('button', { name: 'Filters' }).click()
    const allAgents = orcaPage.getByRole('menuitemradio', { name: 'All agents' })
    await expect(allAgents).toBeVisible()
    const agent = orcaPage.getByRole('menuitemradio', { name: /Shared.*\.agents/ })
    await agent.click()
    await expect(toolbar.getByRole('button', { name: 'Filters (1)' })).toBeVisible()
    await toolbar.getByRole('button', { name: 'Filters (1)' }).click()
    await expect(agent).toHaveAttribute('aria-checked', 'true')
    if (layout.width === 560) {
      await orcaPage.screenshot({ path: info.outputPath('skills-agent-filter.png') })
    }
    await allAgents.click()
    await expect(toolbar.getByRole('button', { name: 'Filters', exact: true })).toBeVisible()
    await toolbar.getByRole('button', { name: 'Filters', exact: true }).click()
    await orcaPage.getByRole('menuitem', { name: 'Clear filters' }).click()
    await expect(toolbar.getByRole('radio', { name: /^All/ })).toHaveAttribute(
      'aria-checked',
      'true'
    )
    await header.getByRole('button', { name: 'Share skills' }).click()
    await expect(header.getByRole('heading', { name: 'Select skills to share' })).toBeVisible()
    const skill = root.getByRole('option', { name: /workbench-example-01/ })
    await skill.focus()
    await orcaPage.keyboard.press('ControlOrMeta+f')
    await expect(search).toBeFocused()
    await skill.focus()
    await orcaPage.keyboard.press('Escape')
    await expect(header.getByRole('heading', { name: 'Skills' })).toBeVisible()
    await header.getByRole('button', { name: 'Install from link' }).click()
    await expect(orcaPage.getByRole('dialog')).toBeVisible()
    await orcaPage.keyboard.press('Escape')
    await expect(root).toBeVisible()
    await header.getByRole('button', { name: 'More actions' }).click()
    await expect(orcaPage.getByRole('menuitem', { name: 'Manage installs' })).toBeVisible()
    await expect(orcaPage.getByRole('menuitem', { name: 'Shared links' })).toBeVisible()
    await expect(orcaPage.getByRole('menuitem', { name: 'Delete skills…' })).toBeVisible()
  })

  test(`Tasks retains provider navigation and search at ${variant}`, async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await orcaPage.evaluate(() =>
      window.__store!.getState().updateSettings({ defaultTaskSource: 'github' })
    )
    const { header, toolbar, root } = await enter(orcaPage, 'tasks', 'Tasks', layout)
    await expect(
      header.locator('[data-contextual-tour-target="tasks-source-filters"]')
    ).toBeVisible()
    await expect(header.locator('[data-contextual-tour-target="tasks-actions"]')).toBeVisible()
    await expect(
      toolbar.locator('[data-contextual-tour-target="tasks-search-presets"]')
    ).toBeVisible()
    await expect(header.getByRole('button', { name: 'Close tasks' })).toBeHidden()
    const search = toolbar.getByRole('textbox')
    await orcaPage.keyboard.press('ControlOrMeta+f')
    await expect(search).toBeFocused()
    if (layout.width === 560) {
      await orcaPage.keyboard.press('Escape')
      await expect(search).toBeHidden()
    }
    await toolbar.getByRole('button', { name: 'Filters' }).click()
    await expect(orcaPage.getByRole('button', { name: 'Closed' })).toBeVisible()
    await orcaPage.getByRole('button', { name: 'Closed' }).click()
    await orcaPage.keyboard.press('Escape')
    if (layout.width === 560) {
      await toolbar.getByRole('button', { name: 'Search', exact: true }).click()
    }
    await expect(search).toHaveValue(/is:closed/)
    await root.getByRole('button', { name: 'Remove Status filter' }).click()
    if (layout.width === 560) {
      await toolbar.getByRole('button', { name: 'Search', exact: true }).click()
    }
    await expect(search).toHaveValue(/is:open/)
    await rail(orcaPage, 'workspaces').click()
    await expect(root).toBeHidden()
  })
}

test('Sidebar destinations keep their Close button and page search with the rail off', async ({
  orcaPage
}) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({
      experimentalAppRail: false,
      showTasksButton: true,
      showSkillsButton: true,
      defaultTaskSource: 'github'
    })
    state.setSidebarOpen(true)
  })
  const { header, toolbar } = bands(orcaPage)
  await orcaPage.locator('[data-contextual-tour-target="sidebar-tasks"]').click()
  await expect(toolbar.getByRole('textbox')).toBeVisible()
  const worktreeSidebar = orcaPage.getByRole('listbox', { name: 'Worktrees' })
  await worktreeSidebar.focus()
  await expect(worktreeSidebar).toBeFocused()
  await orcaPage.keyboard.press('ControlOrMeta+f')
  await expect(toolbar.getByRole('textbox')).toBeFocused()
  await worktreeSidebar.focus()
  await orcaPage.evaluate(() =>
    window.__store!.getState().setKeybindingOverride('page.search', ['Mod+Alt+Shift+J'])
  )
  await orcaPage.keyboard.press('ControlOrMeta+f')
  await expect(toolbar.getByRole('textbox')).not.toBeFocused()
  await orcaPage.keyboard.press('ControlOrMeta+Alt+Shift+J')
  await expect(toolbar.getByRole('textbox')).toBeFocused()
  await header.getByRole('button', { name: 'Close tasks' }).click()
  await expect(header.getByRole('heading', { name: 'Tasks' })).toBeHidden()
  await orcaPage.getByRole('button', { name: 'Skills', exact: true }).click()
  const skillsSearch = toolbar.getByRole('textbox', { name: 'Search skills' })
  const closeSkills = header.getByRole('button', { name: 'Close skills' })
  await expect(skillsSearch).toBeVisible()
  await closeSkills.focus()
  await orcaPage.keyboard.press('ControlOrMeta+Alt+Shift+J')
  await expect(skillsSearch).toBeFocused()
  await closeSkills.click()
  await expect(header.getByRole('heading', { name: 'Skills' })).toBeHidden()
})

test('Tasks retains keyboard view selection, draft filtering and rail history', async ({
  orcaPage
}, info) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({
      defaultTaskSource: 'github',
      defaultTaskViewPreset: 'issues'
    })
  )
  const { header, toolbar, root } = await enter(orcaPage, 'tasks', 'Tasks', {
    width: 560,
    theme: 'dark'
  })
  const filters = toolbar.getByRole('button', { name: /^Filters/ })
  const searchButton = toolbar.getByRole('button', { name: 'Search', exact: true })
  await filters.click()
  const state = orcaPage.getByRole('group', { name: 'State', exact: true })
  const preset = orcaPage.getByRole('group', { name: 'Preset', exact: true })
  await expect(state.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  await expect(preset.getByRole('button', { name: 'Open', exact: true })).toBeVisible()
  const assigned = preset.getByRole('button', { name: 'Assigned to me', exact: true })
  await expect(assigned).toBeVisible()
  await orcaPage.screenshot({ path: info.outputPath('tasks-issue-presets.png') })
  await assigned.click()
  await orcaPage.keyboard.press('Escape')
  await searchButton.click()
  await expect(toolbar.getByRole('textbox')).toHaveValue(/assignee:@me/)
  await orcaPage.keyboard.press('Escape')

  const issues = toolbar.getByRole('radio', { name: 'Issues', exact: true })
  await issues.focus()
  await orcaPage.keyboard.press('ArrowLeft')
  const prs = toolbar.getByRole('radio', { name: 'PRs', exact: true })
  await expect(prs).toBeFocused()
  await expect(issues).toHaveAttribute('aria-checked', 'true')
  await orcaPage.keyboard.press('Enter')
  await expect(prs).toHaveAttribute('aria-checked', 'true')

  await filters.click()
  const open = orcaPage.getByRole('button', { name: 'Open', exact: true })
  const everyone = orcaPage.getByRole('button', { name: 'Everyone', exact: true })
  await expect(open).toBeVisible()
  await expect(everyone).toBeVisible()
  const [stateEdge, whoEdge] = await open
    .or(everyone)
    .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().left))
  expect(whoEdge).toBeCloseTo(stateEdge)
  await orcaPage.screenshot({ path: info.outputPath('tasks-pr-filters.png') })
  await orcaPage.getByRole('button', { name: 'Mine', exact: true }).click()
  await orcaPage.getByRole('button', { name: 'Draft only' }).click()
  await orcaPage.keyboard.press('Escape')
  await searchButton.click()
  await expect(toolbar.getByRole('textbox')).toHaveValue(/author:@me/)
  await expect(toolbar.getByRole('textbox')).toHaveValue(/(?:is:)?draft/)

  await rail(orcaPage, 'automations').click()
  await expect(header.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Go back', exact: true }).click()
  await expect(root.getByRole('heading', { name: 'Tasks', exact: true })).toBeVisible()
  await orcaPage.getByRole('button', { name: 'Go forward', exact: true }).click()
  await expect(header.getByRole('heading', { name: 'Automations', exact: true })).toBeVisible()
})

test('Tasks keeps remote repo selection available in its header', async ({ orcaPage }, info) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    const state = store.getState()
    const fixtureRepo = state.repos[0]
    if (!fixtureRepo) {
      throw new Error('Expected the disposable fixture project')
    }
    const local = {
      ...fixtureRepo,
      displayName: 'Example local project',
      upstream: { owner: 'example', repo: 'local-workbench' }
    }
    await state.updateSettings({
      defaultTaskSource: 'github',
      defaultTaskViewPreset: 'issues',
      defaultRepoSelection: [local.id]
    })
    const target = 'workbench-example-ssh'
    const remote = {
      ...local,
      id: 'workbench-example-hosted-repo',
      displayName: 'Example hosted project',
      executionHostId: `ssh:${target}` as const,
      connectionId: target,
      path: '/example/hosted-workbench',
      upstream: { owner: 'example', repo: 'hosted-workbench' }
    }
    store.setState((current) => ({
      repos: [local, remote],
      sshTargetLabels: new Map([...current.sshTargetLabels, [target, 'Example remote host']]),
      sshConnectionStates: new Map([
        ...current.sshConnectionStates,
        [target, { targetId: target, status: 'disconnected', error: null, reconnectAttempt: 0 }]
      ]),
      getCachedWorkItems: () => [],
      fetchWorkItems: async () => []
    }))
  })
  const { header, root } = await enter(orcaPage, 'tasks', 'Tasks', {
    width: 1280,
    theme: 'light'
  })
  await header.getByRole('combobox').click()
  const remote = orcaPage.getByRole('button', { name: /Example hosted project/ })
  await expect(remote).toBeVisible()
  await expect(remote.getByText(/Example remote host/)).toBeVisible()
  await remote.click()
  await orcaPage.keyboard.press('Escape')
  await expect(header.getByRole('combobox')).toHaveText('All projects')
  await expect(header.getByText(/GitHub · .*Example remote host/)).toBeVisible()
  await expect(root.getByRole('status', { name: /Example remote host disconnected/ })).toBeVisible()
  await orcaPage.screenshot({ path: info.outputPath('tasks-example-remote-host.png') })
})

test('Artifacts keeps the sign-in and Retry states reachable', async ({ orcaPage, inventory }) => {
  const { root, toolbar } = await enter(orcaPage, 'artifacts', 'Artifacts', {
    width: 1280,
    theme: 'light'
  })
  await expect(root.getByRole('heading', { name: 'Sign in to share artifacts' })).toBeVisible()
  await expect(root.getByRole('button', { name: 'Sign in to Orca' })).toBeVisible()
  await expect(toolbar).toBeHidden()

  inventory.artifactsUnavailable = true
  await orcaPage.evaluate(() => window.__store!.getState().connectCurrentOrcaProfile())
  const retry = root.getByRole('button', { name: 'Retry', exact: true })
  await expect(retry).toBeVisible()
  inventory.artifactsUnavailable = false
  await retry.click()
  await expect(retry).toBeHidden()
})

test('Artifacts waits for a successful load before showing a total for each account', async ({
  orcaPage,
  inventory
}) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    await window.__store!.getState().connectCurrentOrcaProfile()
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of [...record.addedNodes, ...record.removedNodes]) {
          if (
            node instanceof Element &&
            (node.matches('[data-rail-page-count]') || node.querySelector('[data-rail-page-count]'))
          ) {
            document.body.dataset.artifactTotalChanged = 'true'
          }
        }
      }
    })
    observer.observe(document.body, { subtree: true, childList: true })
  })
  const first = Promise.withResolvers<void>()
  inventory.waitForArtifacts = first.promise
  const { header } = await enter(orcaPage, 'artifacts', 'Artifacts', {
    width: 1280,
    theme: 'light'
  })
  const count = header.locator('[data-rail-page-count]')
  await expect.poll(() => inventory.artifactRequests).toBeGreaterThan(0)
  await expect(count).toHaveCount(0)
  await expect(orcaPage.locator('body')).not.toHaveAttribute('data-artifact-total-changed')
  first.resolve()
  await expect(count).toHaveText('0')

  const second = Promise.withResolvers<void>()
  const previousRequests = inventory.artifactRequests
  inventory.waitForArtifacts = second.promise
  await orcaPage.evaluate(() => {
    const store = window.__store!
    const status = store.getState().orcaProfileAuthStatus
    if (status?.state !== 'connected') {
      throw new Error('Expected a connected fixture account')
    }
    store.setState({
      orcaProfileAuthStatus: { ...status, activeProfileId: 'example-second-account' }
    })
  })
  await expect.poll(() => inventory.artifactRequests).toBeGreaterThan(previousRequests)
  await expect(count).toHaveCount(0)
  second.resolve()
  await expect(count).toHaveText('0')
})

test('Tasks switches provider controls within the same header and toolbar', async ({
  electronApp,
  orcaPage
}, info) => {
  await electronApp.evaluate(({ app, ipcMain }) => {
    if (app.getPath('home') !== process.env.ORCA_E2E_HOME_DIR) {
      throw new Error('Expected the isolated Electron profile')
    }
    ipcMain.removeHandler('jira:listFavouriteFilters')
    ipcMain.handle('jira:listFavouriteFilters', () => ({
      filters: [
        {
          id: 'example-favourite',
          name: 'Example favourite',
          siteId: 'workbench-jira',
          jql: 'project = EXAMPLE'
        }
      ],
      truncated: false
    }))
  })
  await seedTaskProviders(orcaPage, [
    {
      id: 'workbench-jira-issue',
      key: 'EXAMPLE-42',
      title: 'Example Jira issue',
      url: 'https://jira.example.invalid/browse/EXAMPLE-42',
      project: { id: 'example', key: 'EXAMPLE', name: 'Example' },
      issueType: { id: 'task', name: 'Task' },
      status: { id: 'open', name: 'Example open', categoryKey: 'new', categoryName: 'To Do' },
      labels: [],
      updatedAt: '2026-01-02T00:00:00Z',
      createdAt: '2026-01-02T00:00:00Z'
    }
  ])
  const { header, toolbar } = await enter(orcaPage, 'tasks', 'Tasks', {
    width: 1280,
    theme: 'light'
  })
  await header.locator('[data-task-source="gitlab"]').click()
  await toolbar.getByRole('radio', { name: 'MRs', exact: true }).click()
  await toolbar.getByRole('button', { name: /^Filters/ }).click()
  await orcaPage.getByRole('button', { name: 'Merged', exact: true }).click()
  await orcaPage.keyboard.press('Escape')
  await expect(toolbar.getByRole('button', { name: 'Filters (1)' })).toBeVisible()
  await orcaPage.screenshot({ path: info.outputPath('tasks-gitlab.png') })
  await toolbar.getByRole('radio', { name: 'My Todos' }).click()
  await expect(header.getByRole('button', { name: 'Refresh My Todos' })).toBeVisible()

  await header.locator('[data-task-source="linear"]').click()
  await toolbar.getByRole('radio', { name: 'Issues', exact: true }).click()
  const wideIssueSearch = toolbar.getByRole('textbox')
  await wideIssueSearch.focus()
  await wideIssueSearch.pressSequentially('example')
  await expect(wideIssueSearch).toHaveValue('example')
  await expect(wideIssueSearch).toBeFocused()
  await toolbar.getByRole('radio', { name: 'Projects', exact: true }).click()
  const linearSearch = toolbar.getByRole('textbox')
  await linearSearch.fill('Example project')
  await linearSearch.press('Enter')
  await expect(linearSearch).toHaveValue('Example project')
  await expect(header.getByRole('button', { name: 'New Linear project' })).toBeVisible()
  await orcaPage.screenshot({ path: info.outputPath('tasks-linear.png') })

  await header.locator('[data-task-source="jira"]').click()
  const reported = toolbar.getByRole('radio', { name: 'Reported', exact: true })
  await reported.click()
  await expect(reported).toHaveAttribute('aria-checked', 'true')
  const jiraKeyColumn = bands(orcaPage).root.getByRole('button', { name: /^Key(,|$)/ })
  const jiraKeyCell = bands(orcaPage)
    .root.getByText('EXAMPLE-42', { exact: true })
    .filter({ visible: true })
  await expect(jiraKeyCell).toBeVisible()
  expect(await jiraKeyColumn.evaluate((column) => column.getBoundingClientRect().left)).toBeCloseTo(
    await jiraKeyCell.evaluate((cell) => cell.getBoundingClientRect().left)
  )
  const issueGroup = orcaPage.getByRole('button', { name: 'Example open 1', exact: true })
  await issueGroup.click()
  await expect(jiraKeyCell).toBeHidden()
  await issueGroup.press('Enter')
  await expect(jiraKeyCell).toBeVisible()
  await expect(issueGroup).toHaveCSS('border-radius', '0px')
  await expect(issueGroup).toHaveCSS('box-shadow', /inset/)
  const jiraSearch = toolbar.getByRole('textbox')
  const filters = toolbar.getByRole('button', { name: /^Filters/ })
  await toolbar.getByRole('button', { name: 'Jira favourites', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Example favourite' }).click()
  const activeFavourite = toolbar.getByRole('button', {
    name: 'Jira favourites: Example favourite'
  })
  await expect(activeFavourite).toBeVisible()
  await expect(jiraSearch).toHaveValue('')
  await filters.click()
  await expect(
    orcaPage.getByText('Clear the Jira favourite or choose a preset view to use status filters.')
  ).toBeVisible()
  await orcaPage.screenshot({
    path: info.outputPath('tasks-jira-favourite-filter.png'),
    animations: 'disabled',
    caret: 'hide'
  })
  await orcaPage.keyboard.press('Escape')
  await activeFavourite.click()
  await orcaPage.getByRole('button', { name: 'Clear Jira favourite' }).click()
  await filters.click()
  await expect(orcaPage.getByRole('button', { name: 'Example open', exact: true })).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await jiraSearch.fill('project = EXAMPLE')
  await filters.click()
  await expect(
    orcaPage.getByText('Status filters apply to preset views. Clear the search to use them.')
  ).toBeVisible()
  await orcaPage.keyboard.press('Escape')
  await jiraSearch.press('Enter')
  await expect(jiraSearch).toHaveValue('project = EXAMPLE')
  await expect(header.getByRole('button', { name: 'Refresh Jira issues' })).toBeVisible()
  await orcaPage.screenshot({ path: info.outputPath('tasks-jira.png') })
})

test('Narrow Tasks keeps Linear search composition and keyboard Clear usable', async ({
  orcaPage
}) => {
  await seedTaskProviders(orcaPage)
  const { header, toolbar } = await enter(orcaPage, 'tasks', 'Tasks', { width: 560, theme: 'dark' })
  await header.locator('[data-task-source="linear"]').click()
  await toolbar.getByRole('radio', { name: 'Issues', exact: true }).click()
  const search = toolbar.getByRole('button', { name: 'Search', exact: true })
  const field = toolbar.locator('[data-rail-page-search-field]')
  const input = field.getByRole('textbox')
  const closeSearch = field.getByRole('button', { name: 'Close search', exact: true })
  await search.click()
  await expect(input).toBeFocused()
  const cdp = await orcaPage.context().newCDPSession(orcaPage)
  try {
    await cdp.send('Input.imeSetComposition', { text: '例', selectionStart: 1, selectionEnd: 1 })
    await expect(input).toBeFocused()
    await cdp.send('Input.insertText', { text: '例文' })
    await expect(input).toHaveValue('例文')
    await expect(input).toBeFocused()
  } finally {
    await cdp.detach()
  }
  await closeSearch.click()
  await expect(search).toBeFocused()
  await toolbar.getByRole('radio', { name: 'Projects', exact: true }).focus()
  await orcaPage.keyboard.press('Enter')
  for (const provider of ['linear', 'jira']) {
    if (provider === 'jira') {
      await header.locator('[data-task-source="jira"]').click()
      await toolbar.getByRole('button', { name: 'Filters', exact: true }).click()
      await expect(orcaPage.getByText('No statuses are available for this view yet.')).toBeVisible()
      await orcaPage.keyboard.press('Escape')
    }
    await search.click()
    await input.pressSequentially('example')
    await orcaPage.keyboard.press('Tab')
    await expect(field.getByRole('button', { name: 'Clear search', exact: true })).toBeFocused()
    await orcaPage.keyboard.press('Enter')
    await expect(input).toHaveValue('')
    await expect(input).toBeFocused()
    await orcaPage.keyboard.press('Tab')
    await expect(closeSearch).toBeFocused()
    await orcaPage.keyboard.press('Tab')
    await expect(input).toBeHidden()
  }
})

test('The rail still respects an unsaved Settings draft', async ({ orcaPage }) => {
  await orcaPage.setViewportSize({ width: 1280, height: 800 })
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const state = window.__store!.getState()
    await state.updateSettings({ experimentalAppRail: true, showTasksButton: true })
    state.openSettingsTarget({ pane: 'git', repoId: null })
    state.openSettingsPage()
  })
  const commandTemplate = orcaPage.getByRole('textbox', { name: 'Command template' }).first()
  await expect(commandTemplate).toBeVisible()
  const original = await commandTemplate.inputValue()
  await commandTemplate.fill('Print the example label')
  await rail(orcaPage, 'tasks').click()
  const confirmation = orcaPage.getByRole('dialog', { name: 'Discard unsaved AI settings?' })
  await expect(confirmation).toBeVisible()
  await confirmation.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(commandTemplate).toHaveValue('Print the example label')
  await commandTemplate.fill(original)
  await rail(orcaPage, 'tasks').click()
  await expect(bands(orcaPage).header.getByRole('heading', { name: 'Tasks' })).toBeVisible()
})

test('The floating terminal and editor keep Find when Tasks is open', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(() =>
    window.__store!.getState().updateSettings({
      floatingTerminalEnabled: true,
      floatingTerminalTriggerLocation: 'floating-button',
      defaultTaskSource: 'github'
    })
  )
  const { toolbar } = await enter(orcaPage, 'tasks', 'Tasks', { width: 1280, theme: 'dark' })
  const launcher = orcaPage.getByRole('button', { name: 'Show floating workspace', exact: true })
  await launcher.focus()
  await expect(launcher).toBeFocused()
  await orcaPage.keyboard.press('ControlOrMeta+f')
  await expect(toolbar.getByRole('textbox')).toBeFocused()
  await launcher.click()
  const panel = orcaPage.locator('[data-floating-terminal-panel]')
  const newTerminal = panel.getByRole('button', { name: /^New Terminal/ })
  await newTerminal.click()
  const terminal = panel.locator('.xterm').first()
  await terminal.click()
  await expect(panel.locator('.xterm-helper-textarea').first()).toBeFocused()
  await orcaPage.keyboard.press('ControlOrMeta+f')
  await expect(toolbar.getByRole('textbox')).not.toBeFocused()

  await orcaPage.evaluate(() => {
    const state = window.__store!.getState()
    state.setFloatingWorkspacePanelOpen(false)
    state.openSettingsTarget({ pane: 'shortcuts', repoId: null })
    state.openSettingsPage()
  })
  await orcaPage.getByRole('button', { name: 'Edit file in Orca', exact: true }).click()
  const editor = panel.locator('.monaco-editor').first()
  await expect(editor).toBeVisible()
  await rail(orcaPage, 'tasks').click()
  await expect(toolbar).toBeVisible()
  await editor.locator('.view-lines').click()
  await orcaPage.keyboard.press('ControlOrMeta+f')
  await expect(editor.locator('.find-widget')).toBeVisible()
  await expect(toolbar.getByRole('textbox')).not.toBeFocused()
})

test('Find leaves hidden Tasks list controls alone on issue detail', async ({ orcaPage }) => {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async () => {
    const store = window.__store!
    const state = store.getState()
    const repo = state.repos[0]
    if (!repo) {
      throw new Error('Expected the disposable fixture project')
    }
    const row = {
      id: 'workbench-detail-issue',
      type: 'issue' as const,
      number: 42,
      title: 'Example detail task',
      state: 'open' as const,
      url: 'https://github.example.invalid/example/workbench/issues/42',
      labels: [],
      updatedAt: '2026-01-02T00:00:00Z',
      author: null,
      repoId: repo.id,
      repoHostId: 'local' as const
    }
    await state.updateSettings({ defaultTaskSource: 'github', defaultTaskViewPreset: 'issues' })
    store.setState((current) => ({
      repos: current.repos.map((candidate) =>
        candidate.id === repo.id
          ? {
              ...candidate,
              displayName: 'Example Workbench',
              upstream: { owner: 'example', repo: 'workbench' }
            }
          : candidate
      ),
      getCachedWorkItems: () => [row],
      fetchWorkItems: async () => [row]
    }))
  })
  const { toolbar, root } = await enter(orcaPage, 'tasks', 'Tasks', { width: 1280, theme: 'light' })
  await root.getByText('Example detail task', { exact: true }).click()
  await expect(toolbar).toBeHidden()
  await orcaPage.keyboard.press('ControlOrMeta+f')
  await expect(toolbar.locator('input')).not.toBeFocused()
  await expect(toolbar).toBeHidden()
})
