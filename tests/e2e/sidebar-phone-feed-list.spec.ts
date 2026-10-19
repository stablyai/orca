/**
 * The phone page's workspace list, built from the host's sidebar feed by the page's own modules,
 * matches the desktop sidebar row for row: headers, order, nesting, the single highlight and
 * collapse. Desktop, then a desktop that is a paired server's client.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import path from 'node:path'
import type { Page } from '@stablyai/playwright-test'
import { z } from 'zod'
import { test, expect } from './helpers/orca-app'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'
import { waitForActiveWorktree, waitForSessionReady } from './helpers/store'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient } from './helpers/paired-mobile-client'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import {
  desktopSidebarOutline,
  openPhoneFeedList,
  type ListOutline
} from './helpers/phone-feed-list'

type PhoneList = Awaited<ReturnType<typeof openPhoneFeedList>>

const AddedRepoSchema = z.object({ repo: z.object({ id: z.string() }) })

/** Both sides inside one poll: either may still be catching up with the last change. */
async function expectPhoneMatchesDesktop(page: Page, phone: PhoneList): Promise<ListOutline> {
  let desktop: ListOutline = []
  let shown: ListOutline = []
  await expect
    .poll(
      async () => {
        desktop = await desktopSidebarOutline(page)
        shown = await phone.outline()
        return shown.join('\n') === desktop.join('\n')
      },
      { timeout: 30_000 }
    )
    .toBe(true)
    .catch(() => expect(shown).toEqual(desktop))
  expect(shown.some((line) => line.startsWith('ITEM '))).toBe(true)
  return shown
}

async function runtimeCall(page: Page, method: string, params: unknown): Promise<unknown> {
  return page.evaluate(
    async ({ method, params }) => {
      const response = await window.api.runtime.call({ method, params })
      if (!response.ok) {
        throw new Error(response.error.message)
      }
      return response.result
    },
    { method, params }
  )
}

test.describe('switch on', () => {
  test.skip(
    !SIDEBAR_INPUTS_BUILD,
    'the phone reads the feed only in an ORCA_SIDEBAR_INPUTS=main build'
  )

  test('the phone lists the desktop sidebar from the feed, through pins, the open workspace and collapse', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const activeId = await waitForActiveWorktree(orcaPage)
    const repoId = activeId.split('::')[0]
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
    for (const name of ['feed-a', 'feed-b']) {
      await phone.call('worktree.create', {
        repo: `id:${repoId}`,
        name,
        setupDecision: 'skip'
      })
    }
    const list = await openPhoneFeedList(phone)
    try {
      const first = await expectPhoneMatchesDesktop(orcaPage, list)
      expect(first.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(1)

      // A pin on the desktop reaches the phone through a notice, with a Pinned section.
      await runtimeCall(orcaPage, 'worktree.set', { worktree: `id:${activeId}`, isPinned: true })
      const pinned = await expectPhoneMatchesDesktop(orcaPage, list)
      expect(pinned.some((line) => line.startsWith('HEADER Pinned'))).toBe(true)

      // Pinned rows also in their groups: the open workspace highlights at both.
      await orcaPage.evaluate(() =>
        window.__store!.getState().updateSettings({ showPinnedWorktreesInGroups: true })
      )
      const duplicated = await expectPhoneMatchesDesktop(orcaPage, list)
      expect(duplicated.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(2)

      // The phone collapses one section with ui.setCollapsed; the desktop and the phone both fold it.
      const project = (await list.sections())?.find((section) => section.repo)
      expect(project).toBeDefined()
      const before = await orcaPage.evaluate(() => [...window.__store!.getState().collapsedGroups])
      const reply = await list.request('ui.setCollapsed', {
        key: project!.key,
        collapsed: true,
        opId: { writer: 'e2e-phone', seq: 1 }
      })
      expect(reply).toMatchObject({ ok: true })
      await expect
        .poll(() => orcaPage.evaluate(() => [...window.__store!.getState().collapsedGroups]))
        .toEqual([...before, project!.key])
      const folded = await expectPhoneMatchesDesktop(orcaPage, list)
      const foldedSection = (await list.sections())?.find((section) => section.key === project!.key)
      expect(foldedSection?.data).toEqual([])
      expect(foldedSection?.count).toBeGreaterThan(0)
      expect(folded.length).toBeLessThan(duplicated.length)

      // Expanded again by a later op from the same writer.
      expect(
        await list.request('ui.setCollapsed', {
          key: project!.key,
          collapsed: false,
          opId: { writer: 'e2e-phone', seq: 2 }
        })
      ).toMatchObject({ ok: true })
      await expectPhoneMatchesDesktop(orcaPage, list)
      const unfolded = (await list.sections())?.find((section) => section.key === project!.key)
      expect(unfolded?.data.length).toBeGreaterThan(0)

      // Unpinned on the desktop: the Pinned section goes and one highlight is left.
      await runtimeCall(orcaPage, 'worktree.set', { worktree: `id:${activeId}`, isPinned: false })
      const unpinned = await expectPhoneMatchesDesktop(orcaPage, list)
      expect(unpinned.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(1)
    } finally {
      list.close()
      phone.dispose()
    }
  })

  test('an old open page keeps its own reads on a host that serves the feed', async ({
    orcaPage
  }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
    try {
      // What a page built before the feed reads, unchanged on this host.
      for (const method of ['worktree.ps', 'mobileRelay.projectSections', 'ui.get', 'repo.list']) {
        expect(await phone.request(method, {}), method).toMatchObject({ ok: true })
      }
      const served = await phone.call<{ catalog: { repos: unknown[] } | null }>(
        'mobileRelay.projectSections',
        {}
      )
      expect(served.catalog?.repos.length).toBeGreaterThan(0)
    } finally {
      phone.dispose()
    }
  })

  test('the phone lists a paired server’s workspaces as the desktop sidebar does', async (// oxlint-disable-next-line no-empty-pattern -- this test owns its topology launch.
  {}, testInfo) => {
    test.setTimeout(240_000)
    const serverRepo = testInfo.outputPath('server-repo')
    mkdirSync(serverRepo, { recursive: true })
    writeFileSync(path.join(serverRepo, 'README.md'), 'server repo\n')
    const git = (...args: string[]) => execFileSync('git', args, { cwd: serverRepo, stdio: 'pipe' })
    git('init', '-b', 'main')
    git('add', 'README.md')
    git('-c', 'user.name=E2E', '-c', 'user.email=e2e@test.local', 'commit', '-m', 'init')
    const { host, desktop, phone, dispose } = await launchPhoneMirrorTopology(
      { phoneTo: 'desktop' },
      testInfo
    )
    const list = await openPhoneFeedList(phone)
    try {
      const added = AddedRepoSchema.parse(
        (await host.client.call('repo.add', { path: serverRepo, kind: 'git' })).result
      )
      for (const name of ['server-a', 'server-b']) {
        await host.client.call('worktree.create', {
          repo: `id:${added.repo.id}`,
          name,
          setupDecision: 'skip'
        })
      }
      const shown = await expectPhoneMatchesDesktop(desktop.page, list)
      expect(shown.some((line) => line.includes('server-a'))).toBe(true)
    } finally {
      list.close()
      await dispose()
    }
  })
})
