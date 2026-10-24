/**
 * The phone page's workspace list, built from the host's sidebar feed by the page's own modules,
 * matches the desktop sidebar row for row: headers, order, nesting, the single highlight and
 * collapse. Desktop, then a desktop that is a paired server's client.
 */
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
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
  outlineRows,
  openPhoneFeedList,
  type ListOutline
} from './helpers/phone-feed-list'

type PhoneList = Awaited<ReturnType<typeof openPhoneFeedList>>

const AddedRepoSchema = z.object({ repo: z.object({ id: z.string() }) })

/** Both sides inside one poll: either may still be catching up with the last change. */
/** Waits until both sides agree on a list that already shows the change (`showsChange`). */
async function expectPhoneMatchesDesktop(
  page: Page,
  phone: PhoneList,
  showsChange: (outline: ListOutline) => boolean = () => true
): Promise<ListOutline> {
  let desktop: ListOutline = []
  let shown: ListOutline = []
  await expect
    .poll(
      async () => {
        desktop = await desktopSidebarOutline(page)
        shown = await phone.outline()
        // Why the change too: the phone hears a change later, so both still agree on the old list.
        return (
          outlineRows(shown).join('\n') === outlineRows(desktop).join('\n') && showsChange(shown)
        )
      },
      { timeout: 30_000 }
    )
    .toBe(true)
    .catch(() => expect(outlineRows(shown)).toEqual(outlineRows(desktop)))
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
    // The phone last opened the desktop's workspace, so it highlights that row.
    const list = await openPhoneFeedList(phone, { worktreeId: activeId })
    try {
      const first = await expectPhoneMatchesDesktop(orcaPage, list)
      expect(first.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(1)

      // A pin on the desktop reaches the phone through a notice, with a Pinned section.
      await runtimeCall(orcaPage, 'worktree.set', { worktree: `id:${activeId}`, isPinned: true })
      const hasPinned = (outline: ListOutline): boolean =>
        outline.some((line) => line.startsWith('HEADER Pinned'))
      const pinned = await expectPhoneMatchesDesktop(orcaPage, list, hasPinned)
      expect(hasPinned(pinned)).toBe(true)

      // Pinned rows also in their groups: the open workspace highlights at both.
      await orcaPage.evaluate(() =>
        window.__store!.getState().updateSettings({ showPinnedWorktreesInGroups: true })
      )
      const activeCount = (outline: ListOutline): number =>
        outline.filter((line) => line.endsWith(' ACTIVE')).length
      const duplicated = await expectPhoneMatchesDesktop(
        orcaPage,
        list,
        (outline) => activeCount(outline) === 2
      )
      expect(activeCount(duplicated)).toBe(2)

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
      const folded = await expectPhoneMatchesDesktop(
        orcaPage,
        list,
        (outline) => outline.length < duplicated.length
      )
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
      await expectPhoneMatchesDesktop(
        orcaPage,
        list,
        (outline) => outline.length === duplicated.length
      )
      const unfolded = (await list.sections())?.find((section) => section.key === project!.key)
      expect(unfolded?.data.length).toBeGreaterThan(0)

      // Unpinned on the desktop: the Pinned section goes and one highlight is left.
      await runtimeCall(orcaPage, 'worktree.set', { worktree: `id:${activeId}`, isPinned: false })
      const unpinned = await expectPhoneMatchesDesktop(
        orcaPage,
        list,
        (outline) => !hasPinned(outline)
      )
      expect(activeCount(unpinned)).toBe(1)
    } finally {
      list.close()
      phone.dispose()
    }
  })

  test('the phone files grouped projects under the desktop’s project group, and folds it with the desktop', async ({
    orcaPage,
    registerPostElectronShutdownCleanup
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const activeId = await waitForActiveWorktree(orcaPage)
    const repoId = activeId.split('::')[0]
    const folderPath = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'orca-phone-group-')))
    registerPostElectronShutdownCleanup(async () =>
      rmSync(folderPath, { recursive: true, force: true })
    )
    const folder = AddedRepoSchema.parse(
      await runtimeCall(orcaPage, 'repo.add', { path: folderPath, kind: 'folder' })
    )
    await expect
      .poll(() =>
        orcaPage.evaluate(
          (id) => window.__store!.getState().repos.some((entry) => entry.id === id),
          folder.repo.id
        )
      )
      .toBe(true)
    // A group holding a repo project and a folder project, the folder project first.
    const moved = await orcaPage.evaluate(
      async ({ repoId, folderId }) => {
        const state = () => window.__store!.getState()
        const group = await state().createProjectGroup('school', 'local')
        if (!group) {
          throw new Error('Expected a project group')
        }
        const repoById = (id: string) => {
          const found = state().repos.find((entry) => entry.id === id)
          if (!found) {
            throw new Error(`Expected repo ${id}`)
          }
          return found
        }
        return [
          await state().moveProjectToGroup(repoById(folderId), group.id, 0),
          await state().moveProjectToGroup(repoById(repoId), group.id, 1)
        ]
      },
      { repoId, folderId: folder.repo.id }
    )
    expect(moved).toEqual([true, true])
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
    const list = await openPhoneFeedList(phone)
    try {
      // The group, then the folder project, then the repo project's rows: the desktop's order.
      const inGroup = (outline: ListOutline): boolean => {
        const at = [
          outline.indexOf('HEADER school'),
          outline.indexOf(`HEADER ${path.basename(folderPath)}`),
          outline.findIndex((line) => line.startsWith('ITEM ') && line.includes(repoId))
        ]
        return at[0] !== -1 && at[0] < at[1] && at[1] < at[2]
      }
      const shown = await expectPhoneMatchesDesktop(orcaPage, list, inGroup)
      expect(inGroup(shown)).toBe(true)
      const sections = (await list.sections()) ?? []
      const groupAt = sections.findIndex((section) => section.title === 'school')
      expect(sections[groupAt]).toMatchObject({ isProjectGroup: true })
      // The folder project, then the repo project, both one level in.
      expect(
        sections
          .slice(groupAt + 1, groupAt + 3)
          .map((section) => [section.repo?.id, section.projectGroupDepth])
      ).toEqual([
        [folder.repo.id, 1],
        [repoId, 1]
      ])

      // The phone folds the group; the desktop folds it too, and both hide its projects.
      const key = sections[groupAt]!.key
      expect(
        await list.request('ui.setCollapsed', {
          key,
          collapsed: true,
          opId: { writer: 'e2e-phone-group', seq: 1 }
        })
      ).toMatchObject({ ok: true })
      // Every project sits in the group, so both lists fold down to its header alone.
      await expect
        .poll(async () => [await list.outline(), await desktopSidebarOutline(orcaPage)], {
          timeout: 30_000
        })
        .toEqual([['HEADER school'], ['HEADER school']])

      // The desktop unfolds it; the phone follows.
      await orcaPage.evaluate((key) => window.__store!.getState().toggleCollapsedGroup(key), key)
      await expectPhoneMatchesDesktop(orcaPage, list, (outline) => outline.length === shown.length)
    } finally {
      list.close()
      phone.dispose()
    }
  })

  test('a project group move reaches the phone while an earlier read is held, with no refresh', async ({
    orcaPage
  }) => {
    test.setTimeout(180_000)
    await waitForSessionReady(orcaPage)
    const activeId = await waitForActiveWorktree(orcaPage)
    const repoId = activeId.split('::')[0]
    const [first, second] = await orcaPage.evaluate(async () => {
      const state = window.__store!.getState()
      return Promise.all(
        ['e2e-first', 'e2e-second'].map(
          async (name) => (await state.createProjectGroup(name, 'local'))?.id
        )
      )
    })
    expect(first && second).toBeTruthy()
    const move = (groupId: string) =>
      orcaPage.evaluate(
        async ({ repoId, groupId }) => {
          const state = window.__store!.getState()
          const repo = state.repos.find((candidate) => candidate.id === repoId)
          return repo ? state.moveProjectToGroup(repo, groupId) : false
        },
        { repoId, groupId }
      )
    expect(await move(first!)).toBe(true)
    const phone = pairMobileClient(await createDesktopMobilePairingOffer(orcaPage))
    const list = await openPhoneFeedList(phone)
    const phoneGroupOf = () => {
      const feed = list.feed()
      return feed.kind === 'ready'
        ? feed.domains.projectCatalog?.repos.find((repo) => repo.id === repoId)?.projectGroupId
        : undefined
    }
    try {
      await expectPhoneMatchesDesktop(orcaPage, list)
      expect(phoneGroupOf()).toBe(first)

      // A change the phone reads; the host answers that read before the move lands.
      const hold = list.holdFeedReads()
      await runtimeCall(orcaPage, 'worktree.set', { worktree: `id:${activeId}`, isPinned: true })
      await expect.poll(hold.held, { timeout: 30_000 }).toBeGreaterThan(0)
      expect(await move(second!)).toBe(true)
      hold.release()

      await expectPhoneMatchesDesktop(orcaPage, list)
      expect(phoneGroupOf()).toBe(second)
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
