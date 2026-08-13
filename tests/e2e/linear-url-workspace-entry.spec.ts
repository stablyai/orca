import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import type { LinearIssue } from '../../src/shared/types'

const LINEAR_URL =
  'https://linear.app/stably/issue/STA-4084/restore-osc-133-shell-integration-when-an-exec-in-user-rc-files-strips'
const EXPECTED_WORKSPACE_NAME = 'sta-4084-restore-osc-133-shell-integration-when'

const LINEAR_ISSUE: LinearIssue = {
  id: 'linear-sta-4084',
  workspaceId: 'workspace-1',
  workspaceName: 'Stably',
  identifier: 'STA-4084',
  title: 'Restore OSC 133 shell integration when an exec in user rc files strips',
  branchName: 'sta-4084-restore-osc-133-shell-integration',
  url: LINEAR_URL,
  state: { name: 'Todo', type: 'unstarted', color: '#999999' },
  team: { id: 'team-sta', name: 'Stably', key: 'STA' },
  labels: [],
  labelIds: [],
  priority: 2,
  estimate: null,
  updatedAt: '2026-08-12T00:00:00.000Z'
}

function pasteChord(): string {
  return process.platform === 'darwin' ? 'Meta+V' : 'Control+V'
}

async function installLinearFixture(
  page: Page,
  issue: LinearIssue | null = LINEAR_ISSUE,
  lookupDelayMs: number | null = 150
): Promise<void> {
  await page.evaluate(
    ({ resolvedIssue, lookupDelayMs }) => {
      Reflect.deleteProperty(window, '__orcaTestReleaseLinearLookup')
      const store = window.__store
      if (!store) {
        throw new Error('window.__store is not available')
      }
      store.setState({
        linearStatus: {
          connected: true,
          viewer: null,
          activeWorkspaceId: 'workspace-other',
          selectedWorkspaceId: 'workspace-other',
          workspaces: [
            {
              id: 'workspace-other',
              displayName: 'Other User',
              email: null,
              organizationId: 'organization-other',
              organizationName: 'Other',
              organizationUrlKey: 'other'
            },
            {
              id: 'workspace-1',
              displayName: 'Stably User',
              email: null,
              organizationId: 'organization-stably',
              organizationName: 'Stably',
              organizationUrlKey: 'stably'
            }
          ]
        },
        linearStatusChecked: true,
        checkLinearConnection: async () => {},
        searchLinearIssues: async () => [],
        listLinearIssues: async () => ({ items: [] }),
        fetchLinearIssue: async (_identifier: string, workspaceId?: string | null) => {
          await (lookupDelayMs === null
            ? new Promise<void>((resolve) => {
                Reflect.set(window, '__orcaTestReleaseLinearLookup', resolve)
              })
            : new Promise<void>((resolve) => window.setTimeout(resolve, lookupDelayMs)))
          return resolvedIssue && workspaceId === resolvedIssue.workspaceId ? resolvedIssue : null
        }
      })
    },
    { resolvedIssue: issue, lookupDelayMs }
  )
}

async function releaseHeldLinearLookup(page: Page): Promise<void> {
  await page.evaluate(() => {
    const release = Reflect.get(window, '__orcaTestReleaseLinearLookup')
    if (typeof release !== 'function') {
      throw new Error('Linear lookup is not held')
    }
    Reflect.deleteProperty(window, '__orcaTestReleaseLinearLookup')
    release()
  })
}

async function pasteLinearUrl(page: Page, input: ReturnType<Page['locator']>): Promise<void> {
  await page.evaluate((text) => window.api.ui.writeClipboardText(text), LINEAR_URL)
  await input.focus()
  await page.keyboard.press(pasteChord())
}

async function openJumpPalette(electronApp: ElectronApplication): Promise<void> {
  // Headless Playwright keys bypass Electron's before-input-event shortcut path.
  await electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.webContents.send('ui:toggleWorktreePalette')
  })
}

test.describe('Linear URL workspace entry', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await installLinearFixture(orcaPage)
  })

  test('pasting into the composer selects the Linear issue without ArrowDown', async ({
    orcaPage
  }, testInfo) => {
    await installLinearFixture(orcaPage, LINEAR_ISSUE, null)
    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    const input = dialog.locator('[data-workspace-name-input="true"]')
    await expect(input).toBeVisible()

    await pasteLinearUrl(orcaPage, input)
    await expect
      .poll(() =>
        orcaPage.evaluate(
          () => typeof Reflect.get(window, '__orcaTestReleaseLinearLookup') === 'function'
        )
      )
      .toBe(true)
    await input.press('Enter')
    await expect(input).toHaveValue(LINEAR_URL)
    await expect(dialog.locator('[data-workspace-source-pill="true"]')).toHaveCount(0)
    await releaseHeldLinearLookup(orcaPage)

    const issueRow = orcaPage.getByRole('option', {
      name: `${LINEAR_ISSUE.identifier} ${LINEAR_ISSUE.title}`,
      exact: true
    })
    const useNameRow = orcaPage.getByRole('option', {
      name: `Use "${LINEAR_URL}" as workspace name`,
      exact: true
    })
    await expect(useNameRow).toBeVisible()
    await expect(useNameRow).not.toHaveAttribute('data-selected', 'true')
    await expect(issueRow).toContainText(LINEAR_ISSUE.title)
    await expect(issueRow).toHaveAttribute('data-selected', 'true')
    await testInfo.attach('linear-url-smart-entry-selected.png', {
      body: await dialog.screenshot(),
      contentType: 'image/png'
    })

    await input.press('Enter')
    const sourcePill = dialog.locator('[data-workspace-source-pill="true"]')
    await expect(sourcePill).toContainText(LINEAR_ISSUE.title)
    await expect(dialog.getByPlaceholder('Workspace name')).toHaveValue(EXPECTED_WORKSPACE_NAME)
    await expect(dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i })).toBeEnabled()
    await testInfo.attach('linear-url-smart-entry-composer.png', {
      body: await dialog.screenshot(),
      contentType: 'image/png'
    })
  })

  test('a Linear URL lookup miss falls back to an arbitrary workspace name', async ({
    orcaPage
  }) => {
    await installLinearFixture(orcaPage, null)
    await orcaPage.getByRole('button', { name: 'New workspace', exact: true }).click()
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    const input = dialog.locator('[data-workspace-name-input="true"]')

    await pasteLinearUrl(orcaPage, input)
    const useNameRow = orcaPage.getByRole('option', {
      name: `Use "${LINEAR_URL}" as workspace name`,
      exact: true
    })
    await expect(useNameRow).toHaveAttribute('data-selected', 'true')
    await expect(input).not.toHaveAttribute('aria-busy', 'true')

    await input.press('Enter')
    await expect(input).toHaveValue(LINEAR_URL)
    await expect(dialog.locator('[data-workspace-source-pill="true"]')).toHaveCount(0)
    const suggestions = dialog.locator('[data-workspace-source-suggestions="true"]')
    if (await suggestions.isVisible()) {
      await input.press('Escape')
    }
    await expect(input).not.toHaveAttribute('aria-busy', 'true')
    await input.press('Enter')
    await expect(dialog.locator('[data-agent-combobox-root="true"][role="combobox"]')).toBeFocused()
  })

  test('pasting into Cmd+J previews the Linear issue and opens the linked composer', async ({
    electronApp,
    orcaPage
  }, testInfo) => {
    await openJumpPalette(electronApp)
    const palette = orcaPage.getByRole('dialog', { name: 'Jump to...' })
    const input = palette.getByPlaceholder(
      'Search chats, terminals, worktrees, settings, and actions...'
    )
    await expect(input).toBeVisible()

    await pasteLinearUrl(orcaPage, input)

    const preview = palette.locator(
      '[data-cmd-j-linear-issue-preview="true"][data-cmd-j-linear-issue-state="resolved"]'
    )
    await expect(preview).toContainText(LINEAR_ISSUE.identifier)
    await expect(preview).toContainText(LINEAR_ISSUE.title)
    await expect(preview).toHaveAttribute('data-selected', 'true')
    await testInfo.attach('linear-url-cmd-j-preview.png', {
      body: await palette.screenshot(),
      contentType: 'image/png'
    })

    await input.press('Enter')
    const dialog = orcaPage.getByRole('dialog', { name: /Create (Workspace|Worktree)/i })
    const sourcePill = dialog.locator('[data-workspace-source-pill="true"]')
    await expect(sourcePill).toContainText(LINEAR_ISSUE.title)
    await expect(dialog.getByPlaceholder('Workspace name')).toHaveValue(EXPECTED_WORKSPACE_NAME)
    await expect(dialog.getByRole('button', { name: /Create (Workspace|Worktree)/i })).toBeEnabled()
    await testInfo.attach('linear-url-cmd-j-composer.png', {
      body: await dialog.screenshot(),
      contentType: 'image/png'
    })
  })
})
