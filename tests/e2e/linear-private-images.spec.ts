import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from '@stablyai/playwright-test'
import { test, expect } from './helpers/orca-app'
import type { LinearIssue } from '../../src/shared/linear/issue-types'
import type { LinearIssueUpdate } from '../../src/shared/issue-mutation-types'

declare global {
  var __linearImageSaved: LinearIssueUpdate[] | undefined
}

const SOURCE = 'https://uploads.linear.app/test-workspace/screenshot.png'
const SIGNED = `${SOURCE}?signature=temporary`
const DESCRIPTION = `Screenshot from the issue:\n\n![Screenshot](${SOURCE})\n\nDescription text.`
const ISSUE: LinearIssue = {
  id: 'private-images',
  identifier: 'IMG-1',
  workspaceId: 'test-workspace',
  title: 'Images in Linear tasks',
  description: DESCRIPTION,
  url: 'https://linear.app/test/issue/IMG-1',
  state: { name: 'Todo', type: 'unstarted', color: '' },
  team: { id: 'team-1', name: 'Test', key: 'IMG' },
  labels: [],
  labelIds: [],
  priority: 0,
  updatedAt: '2026-10-06T00:00:00.000Z'
}

async function installFixture(app: ElectronApplication, signed: boolean): Promise<void> {
  await app.evaluate(
    ({ ipcMain }, { issue, source, signedUrl, signed }) => {
      const displayed = {
        ...issue,
        id: signed ? 'after' : 'before',
        ...(signed ? { descriptionImageUrls: { [source]: signedUrl } } : {})
      }
      const saved: LinearIssueUpdate[] = []
      for (const channel of [
        'linear:getIssue',
        'linear:issueComments',
        'linear:updateIssue',
        'linear:listTeams',
        'linear:listIssues',
        'linear:teamStates',
        'linear:teamLabels',
        'linear:teamMembers'
      ]) {
        ipcMain.removeHandler(channel)
      }
      ipcMain.handle('linear:getIssue', () => displayed)
      ipcMain.handle('linear:issueComments', () => [
        {
          id: 'comment-1',
          body: `![Comment screenshot](${signed ? signedUrl : source})`,
          createdAt: issue.updatedAt,
          user: { displayName: 'Test user' }
        }
      ])
      ipcMain.handle('linear:updateIssue', (_event, args: { updates: LinearIssueUpdate }) => {
        saved.push(args.updates)
        return { ok: true }
      })
      ipcMain.handle('linear:listTeams', () => [])
      ipcMain.handle('linear:listIssues', () => ({ items: [] }))
      ipcMain.handle('linear:teamStates', () => [])
      ipcMain.handle('linear:teamLabels', () => [])
      ipcMain.handle('linear:teamMembers', () => [])
      globalThis.__linearImageSaved = saved
    },
    { issue: ISSUE, source: SOURCE, signedUrl: SIGNED, signed }
  )
}

async function openIssue(page: Page, signed: boolean): Promise<void> {
  await page.evaluate(
    ({ issue, signed }) => {
      const store = window.__store
      if (!store) {
        throw new Error('Store unavailable')
      }
      store.setState({
        linearStatus: {
          connected: true,
          viewer: null,
          workspaces: [],
          activeWorkspaceId: 'test-workspace',
          selectedWorkspaceId: 'test-workspace'
        },
        linearStatusChecked: true,
        checkLinearConnection: async () => {}
      })
      store.getState().openTaskPage({
        taskSource: 'linear',
        openLinearIssue: { ...issue, id: signed ? 'after' : 'before' }
      })
    },
    { issue: ISSUE, signed }
  )
  await expect(page.getByLabel('Issue description', { exact: true })).toBeVisible()
  await expect(page.getByRole('link', { name: 'Comment screenshot' })).toBeVisible()
}

test.use({ seedTestRepo: false })

test('private Linear images load without putting signatures into description edits', async ({
  electronApp,
  orcaPage
}, testInfo) => {
  const image = readFileSync(join(process.cwd(), 'resources', 'icon.png'))
  let unsignedRequests = 0
  let signedRequests = 0
  await orcaPage.route('https://uploads.linear.app/**', async (route) => {
    if (new URL(route.request().url()).searchParams.get('signature') === 'temporary') {
      signedRequests++
      await route.fulfill({ status: 200, contentType: 'image/png', body: image })
    } else {
      unsignedRequests++
      await route.fulfill({ status: 401, body: 'Unauthorized' })
    }
  })

  await installFixture(electronApp, false)
  await openIssue(orcaPage, false)
  await expect.poll(() => unsignedRequests).toBeGreaterThanOrEqual(1)
  await expect
    .poll(() =>
      orcaPage
        .getByAltText('Screenshot', { exact: true })
        .evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth === 0)
    )
    .toBe(true)
  await testInfo.attach('linear-images-before.png', {
    body: await orcaPage.screenshot({ path: testInfo.outputPath('linear-images-before.png') }),
    contentType: 'image/png'
  })

  await installFixture(electronApp, true)
  await openIssue(orcaPage, true)
  await expect
    .poll(() =>
      orcaPage
        .getByAltText('Screenshot', { exact: true })
        .evaluate((img: HTMLImageElement) => img.naturalWidth)
    )
    .toBeGreaterThan(0)
  await expect(orcaPage.getByRole('link', { name: 'Comment screenshot' })).toHaveAttribute(
    'href',
    SIGNED
  )
  await expect.poll(() => signedRequests).toBeGreaterThanOrEqual(1)
  await testInfo.attach('linear-images-after.png', {
    body: await orcaPage.screenshot({ path: testInfo.outputPath('linear-images-after.png') }),
    contentType: 'image/png'
  })

  const editor = orcaPage.getByLabel('Issue description', { exact: true })
  await editor.click()
  await editor.press('End')
  await editor.press('ArrowRight')
  await editor.press('Enter')
  await editor.pressSequentially('Verified edit')
  await orcaPage.getByRole('textbox', { name: 'Issue title' }).click()
  await expect
    .poll(() => electronApp.evaluate(() => globalThis.__linearImageSaved))
    .toEqual([{ description: expect.stringContaining(`![Screenshot](${SOURCE})`) }])
  const saved = await electronApp.evaluate(() => globalThis.__linearImageSaved)
  expect(JSON.stringify(saved)).toContain('Verified edit')
  expect(JSON.stringify(saved)).not.toContain('signature=')
})
