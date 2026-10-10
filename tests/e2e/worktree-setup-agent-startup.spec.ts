import { execFileSync } from 'node:child_process'
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { expect, test } from './helpers/orca-app'
import { getGoldenStubAgentLaunchEnv, GOLDEN_STUB_READY_MARKER } from './helpers/golden-stub-agent'
import { openSidebarWorkspaceComposer } from './helpers/sidebar-project-dialog'
import { waitForSessionReady, waitForActiveWorktree } from './helpers/store'
import { getTerminalContent, focusActiveTerminalInput } from './helpers/terminal'

test.use({ launchEnv: getGoldenStubAgentLaunchEnv() })

for (const existingShell of [false, true]) {
  test(`starts the agent after setup after early navigation (${existingShell ? 'user shell preserved' : 'no extra shell'})`, async ({
    orcaPage,
    seededRepoPath
  }, testInfo) => {
    await waitForSessionReady(orcaPage)
    const originalWorktreeId = await waitForActiveWorktree(orcaPage)
    const fixtureScript = path.join(
      process.cwd(),
      'tests/e2e/fixtures/golden-stub-agent/golden-stub-agent.js'
    )
    writeFileSync(
      path.join(seededRepoPath, 'orca.yaml'),
      `setupAgentStartupPolicy: wait-for-setup\nscripts:\n  setup: >-\n    node -e "require('node:fs').writeFileSync('setup-finished.txt', 'done')"\n`
    )
    writeFileSync(
      path.join(seededRepoPath, 'startup-after-setup.cjs'),
      `if (!require('node:fs').existsSync('setup-finished.txt')) throw new Error('Agent started before setup');\nrequire(${JSON.stringify(fixtureScript)});\n`
    )
    execFileSync('git', ['add', 'orca.yaml', 'startup-after-setup.cjs'], { cwd: seededRepoPath })
    execFileSync('git', ['commit', '--allow-empty', '-m', 'test: configure setup-gated agent'], {
      cwd: seededRepoPath
    })

    await orcaPage.evaluate(async () => {
      const store = window.__store
      if (!store) {
        throw new Error('Orca store is unavailable')
      }
      await store.getState().updateSettings({
        defaultTuiAgent: 'codex',
        agentCmdOverrides: { codex: 'node startup-after-setup.cjs' },
        agentDefaultArgs: { codex: '' },
        setupScriptLaunchMode: 'new-tab',
        experimentalNativeChat: false,
        openAgentTabsInChatByDefault: false
      })
      const originalCreate = store.getState().createWorktree
      store.setState({
        createWorktree: async (...args) => {
          // Keep creation pending until the user opens the published checkout.
          args[16] = undefined
          const result = await originalCreate(...args)
          if (result.startupTerminal?.spawned) {
            throw new Error('Expected renderer-owned startup')
          }
          const canComplete = () => {
            const state = store.getState()
            const pending = Object.values(state.pendingWorktreeCreations).find(
              (entry) => entry.worktreeId === result.worktree.id
            )
            return state.activeWorktreeId === result.worktree.id && pending?.loaderVisible === false
          }
          await new Promise<void>((resolve) => {
            if (canComplete()) {
              resolve()
              return
            }
            const unsubscribe = store.subscribe(() => {
              if (canComplete()) {
                unsubscribe()
                resolve()
              }
            })
          })
          return result
        }
      })
    })

    await openSidebarWorkspaceComposer(orcaPage)
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    await dialog.getByPlaceholder(/Type a name/i).fill(`setup-agent-${Date.now()}`)
    const agentPicker = dialog.locator('[data-agent-combobox-root="true"][role="combobox"]')
    await agentPicker.click()
    await orcaPage
      .getByRole('option', { name: /^Codex/ })
      .first()
      .click()
    await dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i }).click()
    await expect(dialog).toBeHidden({ timeout: 30_000 })
    await orcaPage.getByRole('button', { name: 'Run hooks', exact: true }).click()

    await expect
      .poll(
        () =>
          orcaPage.evaluate(() => {
            const state = window.__store?.getState()
            return Object.values(state?.pendingWorktreeCreations ?? {}).find(
              (entry) => entry.worktreeId
            )?.worktreeId
          }),
        { timeout: 30_000 }
      )
      .toBeTruthy()
    const creatingWorktreeId = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return Object.values(state?.pendingWorktreeCreations ?? {}).find((entry) => entry.worktreeId)
        ?.worktreeId
    })
    expect(creatingWorktreeId).not.toBe(originalWorktreeId)
    await orcaPage
      .locator(
        `[data-worktree-sidebar] [role="option"][data-worktree-id=${JSON.stringify(creatingWorktreeId)}]`
      )
      .click()

    expect(
      await orcaPage.evaluate(
        (worktreeId) =>
          worktreeId ? (window.__store?.getState().tabsByWorktree[worktreeId]?.length ?? 0) : -1,
        creatingWorktreeId
      )
    ).toBe(0)
    if (existingShell) {
      await orcaPage.evaluate((worktreeId) => {
        const state = window.__store?.getState()
        if (!state || !worktreeId) {
          throw new Error('Created workspace is unavailable')
        }
        const shell = state.createTab(worktreeId)
        state.setTabCustomTitle(shell.id, 'User shell')
      }, creatingWorktreeId)
    }
    await orcaPage.evaluate((worktreeId) => {
      const state = window.__store?.getState()
      const pending = Object.values(state?.pendingWorktreeCreations ?? {}).find(
        (entry) => entry.worktreeId === worktreeId
      )
      if (!state || !pending) {
        throw new Error('Pending creation is unavailable')
      }
      state.updatePendingWorktreeCreation(pending.creationId, { loaderVisible: false })
    }, creatingWorktreeId)
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => Object.keys(window.__store?.getState().pendingWorktreeCreations ?? {}).length
        )
      )
      .toBe(0)
    const agentTabId = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      if (!state?.activeWorktreeId) {
        throw new Error('Created workspace is unavailable')
      }
      return state.tabsByWorktree[state.activeWorktreeId]?.find(
        (tab) => tab.launchAgent === 'codex'
      )?.id
    })
    expect(agentTabId).toBeTruthy()
    const createdWorktreePath = await orcaPage.evaluate(() => {
      const state = window.__store?.getState()
      return state?.activeWorktreeId
        ? state.getKnownWorktreeById(state.activeWorktreeId)?.path
        : undefined
    })
    if (!createdWorktreePath) {
      throw new Error('Created checkout path is unavailable')
    }
    await orcaPage.locator('[data-testid="sortable-tab"][data-tab-title="Setup"]').click()
    await expect
      .poll(() => existsSync(path.join(createdWorktreePath, 'setup-finished.txt')), {
        timeout: 30_000
      })
      .toBe(true)
    await orcaPage.locator(`[data-testid="sortable-tab"][data-tab-id="${agentTabId}"]`).click()
    await expect
      .poll(() => getTerminalContent(orcaPage), { timeout: 30_000 })
      .toContain(GOLDEN_STUB_READY_MARKER)
    await expect(orcaPage.locator('[data-testid="sortable-tab"]:visible')).toHaveCount(
      existingShell ? 3 : 2
    )
    expect(
      await orcaPage.evaluate(() => {
        const state = window.__store?.getState()
        return state?.activeWorktreeId
          ? state.tabsByWorktree[state.activeWorktreeId]?.filter(
              (tab) => tab.launchAgent === 'codex'
            ).length
          : 0
      })
    ).toBe(1)
    if (existingShell) {
      await expect(orcaPage.getByText('User shell', { exact: true })).toBeVisible()
    }
    await expect(orcaPage.getByText('Setup', { exact: true })).toBeVisible()

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.type('startup confirmed')
    await expect.poll(() => getTerminalContent(orcaPage)).toContain('> startup confirmed')
    await orcaPage.screenshot({ path: testInfo.outputPath('setup-agent-started.png') })
  })
}
