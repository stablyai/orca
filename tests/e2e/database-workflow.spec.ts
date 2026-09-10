import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'

test('database table preview, refresh, and keyboard return preserve the project query', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  // Exercise the real renderer and IPC boundary with deterministic database responses.
  await electronApp.evaluate(({ ipcMain }) => {
    type Handler = (
      event: unknown,
      args: { method: string; params?: Record<string, unknown> }
    ) => unknown
    const handlers = (ipcMain as unknown as { _invokeHandlers: Map<string, Handler> })
      ._invokeHandlers
    const original = handlers.get('runtime:call')
    if (!original) {
      throw new Error('Runtime IPC unavailable')
    }
    let profile: Record<string, unknown> | undefined
    let queries = 0
    handlers.set('runtime:call', (event, args) => {
      if (!args.method.startsWith('database.')) {
        return original(event, args)
      }
      const params = args.params ?? {}
      let result: unknown
      switch (args.method) {
        case 'database.profiles.list':
          result = { profiles: [] }
          break
        case 'database.profiles.save':
          profile = {
            ...(params.profile as Record<string, unknown>),
            id: 'workflow-fixture',
            hasSavedPassword: false
          }
          result = profile
          break
        case 'database.testConnection':
          result = { database: 'app', serverVersion: '17.0' }
          break
        case 'database.catalog':
          result = {
            databases: ['app'],
            schemas: ['public'],
            currentDatabase: 'app',
            currentSchema: 'public'
          }
          break
        case 'database.introspect':
          result = {
            tables: [
              {
                schema: 'public',
                name: 'activity_events',
                columns: [
                  { name: 'id', dataType: 'bigint', nullable: false, defaultValue: null },
                  { name: 'event', dataType: 'text', nullable: false, defaultValue: null },
                  { name: 'created_at', dataType: 'timestamp', nullable: false, defaultValue: null }
                ]
              }
            ]
          }
          break
        case 'database.execute':
          queries++
          result = {
            columns: [
              { name: 'id', dataTypeId: 20 },
              { name: 'event', dataTypeId: 25 },
              { name: 'created_at', dataTypeId: 1114 }
            ],
            rows: [
              [1, 'signed_up', '2026-09-10 10:00:00'],
              ...(queries > 1 ? [[2, 'project_created', '2026-09-10 10:00:05']] : [])
            ],
            rowCount: queries > 1 ? 2 : 1,
            command: 'SELECT',
            durationMs: 12,
            truncated: false
          }
          break
        case 'database.cancel':
          result = { canceled: true }
          break
        default:
          throw new Error(`Unexpected database fixture method: ${args.method}`)
      }
      return { ok: true, result }
    })
  })

  await orcaPage.setViewportSize({ width: 1440, height: 960 })
  const terminalId = await orcaPage.evaluate(async () => {
    const store = window.__store!
    store.setState({
      settings: { ...store.getState().settings!, uiLanguage: 'en' }
    })
    await store.getState().setKeybindingOverride('workspace.openDatabase', ['Ctrl+Alt+D'])
    return store.getState().activeTabId
  })
  await testInfo.attach('before-terminal-workspace', {
    body: await orcaPage.screenshot({ path: testInfo.outputPath('before-terminal-workspace.png') }),
    contentType: 'image/png'
  })
  await orcaPage.getByRole('button', { name: 'New tab', exact: true }).first().click()
  await orcaPage.getByRole('menuitem', { name: 'New Database Query', exact: true }).click()
  await expect(orcaPage.getByText('PostgreSQL connection', { exact: true })).toBeVisible()
  await expect(
    orcaPage.getByText(
      'Profiles and saved passwords belong to this project node. Passwords stay in its encrypted vault and are never returned to clients.',
      { exact: true }
    )
  ).toBeVisible()
  await orcaPage.locator('input[id$="-profile-name"]').fill('Project database')
  await orcaPage.locator('input[id$="-name"]:not([id$="-profile-name"])').fill('app')
  await orcaPage.getByRole('button', { name: 'Save and connect', exact: true }).click()
  const query = orcaPage.getByRole('textbox', { name: 'SQL query', exact: true })
  await expect(query).toBeVisible()
  await orcaPage.getByRole('button', { name: /activity_events/ }).click()
  await expect(orcaPage.getByRole('cell', { name: 'signed_up', exact: true })).toBeVisible()
  await expect(query).toHaveValue('SELECT * FROM "public"."activity_events"\nLIMIT 500;')
  await orcaPage.getByRole('button', { name: 'Refresh results', exact: true }).click()
  await expect(orcaPage.getByRole('cell', { name: 'project_created', exact: true })).toBeVisible()
  await expect(orcaPage.getByRole('status').filter({ hasText: '2 rows' })).toBeVisible()
  await orcaPage.getByRole('combobox', { name: 'Auto-refresh', exact: true }).click()
  await orcaPage.getByRole('option', { name: 'Every 5s', exact: true }).click()
  await expect(orcaPage.getByRole('option', { name: 'Every 5s', exact: true })).not.toBeVisible()
  await testInfo.attach('after-project-database', {
    body: await orcaPage.screenshot({ path: testInfo.outputPath('after-project-database.png') }),
    contentType: 'image/png'
  })

  await orcaPage.locator(`[data-tab-id="${terminalId}"]`).first().click()
  await expect(query).not.toBeVisible()
  await orcaPage.keyboard.press('Control+Alt+d')
  await expect(query).toBeVisible()
  await expect(query).toBeFocused()
  await expect(orcaPage.getByRole('cell', { name: 'project_created', exact: true })).toBeVisible()
  await orcaPage.keyboard.press('Control+Alt+d')
  await expect(orcaPage.locator('[data-tab-type="database"]')).toHaveCount(1)
  await expect(query).toBeFocused()
  await orcaPage.getByRole('button', { name: 'Close database tab', exact: true }).click()
  await expect(query).toHaveCount(0)
  await expect(orcaPage.locator('[data-tab-type="database"]')).toHaveCount(0)
})

test('main titlebar bulk close preserves pinned database tabs and localizes the connection form', async ({
  orcaPage
}, testInfo) => {
  await waitForSessionReady(orcaPage)
  const worktreeId = await waitForActiveWorktree(orcaPage)
  await orcaPage.setViewportSize({ width: 1440, height: 960 })
  await orcaPage.evaluate(async (id) => {
    const state = window.__store!.getState()
    await state.updateSettings({ uiLanguage: 'en' })
    for (const tab of state.unifiedTabsByWorktree[id] ?? []) {
      state.pinTab(tab.id)
    }
    for (const name of ['pinned', 'left', 'anchor', 'right']) {
      state.createUnifiedTab(id, 'database', {
        id: `bulk-${name}`,
        label: `Query ${name}`,
        isPinned: name === 'pinned'
      })
    }
  }, worktreeId)

  const tab = (name: string) => orcaPage.locator(`[data-tab-id="bulk-${name}"]`).first()
  await expect(orcaPage.locator('[data-tab-type="database"]')).toHaveCount(4)
  await tab('anchor').click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Close Tabs To The Right', exact: true }).click()
  await expect(tab('right')).toHaveCount(0)
  await expect(tab('left')).toBeVisible()
  await expect(tab('pinned')).toBeVisible()

  await tab('anchor').click({ button: 'right' })
  await orcaPage.getByRole('menuitem', { name: 'Close Others', exact: true }).click()
  await expect(tab('left')).toHaveCount(0)
  await expect(tab('anchor')).toBeVisible()
  await expect(tab('pinned')).toBeVisible()
  await expect(orcaPage.locator('[data-tab-type="database"]')).toHaveCount(2)

  await tab('anchor').click()
  await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'ko' }))
  const visible = orcaPage.locator(':visible')
  await expect(orcaPage.getByText('PostgreSQL 연결', { exact: true }).and(visible)).toBeVisible()
  await expect(orcaPage.getByLabel('호스트', { exact: true }).and(visible)).toBeVisible()
  await expect(orcaPage.getByLabel('비밀번호', { exact: true }).and(visible)).toBeVisible()
  await expect(orcaPage.getByRole('button', { name: '저장 및 연결', exact: true })).toBeVisible()
  await orcaPage.screenshot({
    path: testInfo.outputPath('database-korean-connection.png'),
    animations: 'disabled'
  })
})
