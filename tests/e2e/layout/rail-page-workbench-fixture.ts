import { createServer } from 'node:http'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, type ElectronApplication, type Page } from '@stablyai/playwright-test'
import type { ArtifactListItem } from '../../../src/shared/artifacts/artifacts'
import { test as electronTest } from '../desktop/electron-fixtures/orca-app'
import type { JiraIssue } from '../../../src/shared/jira/jira-types'
import { waitForSessionReady } from '../desktop/renderer-probes/store'

type Destination = 'artifacts' | 'automations' | 'skills' | 'tasks'

export function rail(page: Page, destination: Destination | 'workspaces') {
  return page.locator(`[data-app-rail-item="${destination}"]`)
}

export function bands(page: Page) {
  const root = page.locator('[data-rail-page]')
  return {
    root,
    header: root.locator('[data-rail-page-header]'),
    toolbar: root.locator('[data-rail-page-toolbar]')
  }
}

export const test = electronTest.extend<{
  inventory: {
    artifacts: ArtifactListItem[]
    artifactsUnavailable: boolean
    artifactRequests: number
    waitForArtifacts?: Promise<void>
  }
}>({
  // oxlint-disable-next-line no-empty-pattern -- Playwright fixtures require object destructuring.
  inventory: async ({}, provideFixture) => {
    await provideFixture({ artifacts: [], artifactsUnavailable: false, artifactRequests: 0 })
  },
  orcaAppExtraEnv: async ({ inventory }, provideFixture) => {
    const server = createServer(async (request, response) => {
      const path = request.url?.split('?')[0]
      if (path === '/v1/artifacts') {
        inventory.artifactRequests += 1
        await inventory.waitForArtifacts
      }
      if (path === '/v1/artifacts' && inventory.artifactsUnavailable) {
        response.writeHead(503, { 'Content-Type': 'application/json' })
        response.end(JSON.stringify({ error: 'Example artifact service unavailable' }))
        return
      }
      const data =
        path === '/v1/artifacts'
          ? { artifacts: inventory.artifacts }
          : path === '/v1/skill-shares'
            ? { shares: [] }
            : null
      response.writeHead(data ? 200 : 404, { 'Content-Type': 'application/json' })
      response.end(JSON.stringify(data ?? { error: 'No fixture for this route' }))
    })
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('Expected a loopback HTTP port')
      }
      const origin = `http://127.0.0.1:${address.port}`
      await provideFixture({
        ORCA_ARTIFACTS_API_URL: origin,
        ORCA_CLOUD_API_URL: origin,
        ORCA_CLOUD_CLIENT_ID: 'workbench-fixture',
        ORCA_CLOUD_DEV_AUTH: '1',
        ORCA_CLOUD_DEV_DISPLAY_NAME: 'Example Account',
        ORCA_CLOUD_DEV_EMAIL: 'example@example.invalid'
      })
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()))
      })
    }
  }
})

export async function enter(
  page: Page,
  destination: Destination,
  title: string,
  options: { width: number; theme: 'light' | 'dark' }
): Promise<ReturnType<typeof bands>> {
  await page.setViewportSize({ width: options.width, height: 800 })
  await waitForSessionReady(page)
  await page.evaluate(async (theme) => {
    await window.__store!.getState().updateSettings({
      theme,
      experimentalAppRail: true,
      showArtifactsButton: true,
      showAutomationsButton: true,
      showSkillsButton: true,
      showTasksButton: true
    })
  }, options.theme)
  await rail(page, destination).click()
  const chrome = bands(page)
  await expect(chrome.header.getByRole('heading', { name: title, exact: true })).toBeVisible()
  await expect(chrome.header).toHaveCSS('height', '52px')
  return chrome
}

export async function seedSkills(app: ElectronApplication): Promise<void> {
  const home = await app.evaluate(({ app: electron }) => {
    const isolatedHome = process.env.ORCA_E2E_HOME_DIR
    if (!isolatedHome || electron.getPath('home') !== isolatedHome) {
      throw new Error('Expected the test fixture’s isolated home directory')
    }
    return isolatedHome
  })
  for (let index = 1; index <= 20; index += 1) {
    const name = `workbench-example-${String(index).padStart(2, '0')}`
    const folder = join(home, '.agents', 'skills', name)
    await mkdir(folder, { recursive: true })
    await writeFile(
      join(folder, 'SKILL.md'),
      `---\nname: ${name}\ndescription: An invented skill for the Workbench test.\n---\n`
    )
  }
}

export async function seedAutomations(page: Page): Promise<void> {
  await waitForSessionReady(page)
  await page.evaluate(async () => {
    const repo = window.__store!.getState().repos[0]
    if (!repo) {
      throw new Error('Expected the disposable fixture project')
    }
    for (let index = 1; index <= 20; index += 1) {
      const result = await window.api.runtime.call({
        method: 'automation.create',
        params: {
          name: `Example automation ${String(index).padStart(2, '0')}`,
          prompt: 'Print the example label',
          repo: `id:${repo.id}`,
          agentId: 'codex',
          rrule: 'FREQ=DAILY;BYHOUR=9;BYMINUTE=0',
          dtstart: Date.parse('2099-01-01T09:00:00Z'),
          timezone: 'UTC',
          enabled: false
        }
      })
      if (!result.ok) {
        throw new Error(result.error.message)
      }
    }
  })
}

export async function seedTaskProviders(
  orcaPage: Page,
  jiraIssues: JiraIssue[] = []
): Promise<void> {
  await waitForSessionReady(orcaPage)
  await orcaPage.evaluate(async (issues) => {
    const store = window.__store!
    const state = store.getState()
    await state.updateSettings({
      defaultTaskSource: 'github',
      visibleTaskProviders: ['github', 'gitlab', 'linear', 'jira']
    })
    await state.refreshPreflightStatus()
    store.setState({
      listJiraIssues: async () => issues,
      searchJiraIssues: async () => issues,
      preflightStatus: {
        git: { installed: true },
        gh: { installed: true, authenticated: true },
        glab: { installed: true, authenticated: true }
      },
      linearStatusChecked: true,
      linearStatusContextKey: 'local#0',
      linearStatus: {
        connected: true,
        viewer: null,
        selectedWorkspaceId: 'workbench-linear',
        workspaces: [
          {
            id: 'workbench-linear',
            organizationId: 'example',
            organizationName: 'Example Linear',
            displayName: 'Example Account',
            email: null
          }
        ]
      },
      jiraStatusChecked: true,
      jiraStatusContextKey: 'local#0',
      jiraStatus: {
        connected: true,
        viewer: null,
        selectedSiteId: 'workbench-jira',
        sites: [
          {
            id: 'workbench-jira',
            siteUrl: 'https://jira.example.invalid',
            displayName: 'Example Jira',
            email: 'example@example.invalid',
            accountId: 'example'
          }
        ]
      }
    })
  }, jiraIssues)
}
