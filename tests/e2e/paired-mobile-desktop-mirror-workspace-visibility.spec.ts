/**
 * Phone paired with a desktop that is a client of an `orca serve` host: the phone's server rows
 * must be the ones the desktop's own sidebar shows, under the desktop's "Hide other-client
 * workspaces" and "Hide sleeping" filters, which the server alone cannot evaluate.
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { z } from 'zod'
import { expect, test } from './helpers/orca-app'
import { NO_WORKSPACE_ROW_FILTERS } from '../../src/shared/workspace-view/workspace-row-filters'
import { launchPhoneMirrorTopology } from './helpers/phone-mirror-topology'
import type { PairedMobileSocket } from './helpers/paired-mobile-client'
import {
  filterWorktrees,
  getWorktreeStatus,
  type Worktree
} from '../../mobile/src/worktree/workspace-list-sections'

const ServerRowsSchema = z.object({
  worktrees: z.array(
    z.looseObject({
      worktreeId: z.string(),
      repoId: z.string(),
      path: z.string(),
      branch: z.string(),
      isMainWorktree: z.boolean().optional(),
      hasHostSidebarActivity: z.boolean().optional(),
      status: z.enum(['working', 'active', 'permission', 'done', 'inactive']).optional(),
      desktopOtherClient: z.literal(true).optional()
    })
  )
})
const ReposSchema = z.object({
  repos: z.array(z.looseObject({ id: z.string(), path: z.string() }))
})
const HostsSchema = z.object({ hosts: z.array(z.looseObject({ hostId: z.string() })) })
const ProjectSectionsSchema = z.object({
  catalog: z
    .object({
      repos: z.array(z.looseObject({ path: z.string(), executionHostId: z.string().optional() }))
    })
    .nullable()
})
const TabsSchema = z.looseObject({ tabs: z.array(z.looseObject({ id: z.string() })) })

let requestId = 0
async function result(
  socket: PairedMobileSocket,
  method: string,
  params: unknown,
  executionHost?: string
): Promise<unknown> {
  requestId += 1
  const id = `visibility-${requestId}`
  socket.send(id, method, params, executionHost)
  let frame: PairedMobileSocket['frames'][number] | undefined
  await expect
    .poll(() => (frame = socket.frames.find((entry) => entry.id === id)), { timeout: 30_000 })
    .toBeDefined()
  expect(frame?.ok, `${method}: ${JSON.stringify(frame?.error)}`).toBe(true)
  return frame?.result
}

test("phone lists a server's workspaces exactly as the desktop sidebar filters them", async (// oxlint-disable-next-line no-empty-pattern -- this test owns its topology launch.
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
  try {
    await host.client.call('repo.add', { path: serverRepo, kind: 'git' })
    const socket = await phone.openSocket()
    const { hosts } = HostsSchema.parse(await result(socket, 'mobileRelay.hosts.list', {}))
    const serverHostId = hosts[0]?.hostId ?? ''
    expect(serverHostId).toMatch(/^runtime:/)
    const { repos } = ReposSchema.parse(await result(socket, 'repo.list', {}, serverHostId))
    const repo = `id:${repos.find((entry) => entry.path === serverRepo)?.id ?? ''}`
    const create = { setupDecision: 'skip' }
    // The desktop window publishes the catalog its sidebar groups Project sections with.
    await expect
      .poll(
        async () =>
          ProjectSectionsSchema.parse(
            await result(socket, 'mobileRelay.projectSections', {})
          ).catalog?.repos.some(
            (entry) => entry.path === serverRepo && entry.executionHostId === serverHostId
          ) ?? false,
        { timeout: 30_000 }
      )
      .toBe(true)

    // One workspace each: created on the server itself, by the desktop, and by the phone through it.
    await host.client.call('worktree.create', { repo, name: 'from-server', ...create })
    await desktop.page.evaluate(
      async ({ environmentId, params }) => {
        const response = await window.api.runtimeEnvironments.call({
          selector: environmentId,
          method: 'worktree.create',
          params
        })
        if (!response.ok) {
          throw new Error(response.error.message)
        }
      },
      { environmentId: desktop.environmentId, params: { repo, name: 'from-desktop', ...create } }
    )
    await result(socket, 'worktree.create', { repo, name: 'from-phone', ...create }, serverHostId)

    const phoneRows = async () =>
      ServerRowsSchema.parse(
        await result(socket, 'mobileRelay.hosts.worktrees', { hostId: serverHostId })
      ).worktrees
    const named = (rows: { path: string }[], suffix: string) =>
      rows.some((row) => row.path.endsWith(suffix))
    /** The phone's rows after its own filters, against the server rows the desktop sidebar renders. */
    const expectPhoneMatchesSidebar = async (hideSleeping: boolean): Promise<string[]> => {
      let shown: string[] = []
      // Why both sides inside the poll: either can still be catching up with the last change.
      await expect
        .poll(
          async () => {
            const rows = await phoneRows()
            const serverIds = new Set(rows.map((row) => row.worktreeId))
            const phone = filterWorktrees(
              rows.map(toMobileRow),
              {
                ...NO_WORKSPACE_ROW_FILTERS,
                hideSleepingWorkspaces: hideSleeping,
                hideWorkspacesFromOtherDevices: true
              },
              ''
            )
            shown = phone.map((row) => row.path)
            const rendered = await desktop.page
              .locator('[data-worktree-id]')
              .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-worktree-id')))
            const sidebar = [...new Set(rendered)]
              .filter((id): id is string => id !== null && serverIds.has(id))
              .sort()
            return (
              JSON.stringify(sidebar) === JSON.stringify(phone.map((row) => row.worktreeId).sort())
            )
          },
          { timeout: 30_000 }
        )
        .toBe(true)
      return shown
    }

    // The desktop marks the server's own row as another client's; the desktop's and its phone's stay.
    await expect
      .poll(
        async () => {
          const marked = (await phoneRows()).filter((row) => row.desktopOtherClient)
          return [
            named(marked, 'from-server'),
            named(marked, 'from-desktop'),
            named(marked, 'from-phone')
          ]
        },
        { timeout: 60_000 }
      )
      .toEqual([true, false, false])
    // The marks are facts, so they were there before the filter; the phone applies the value.
    await desktop.page.evaluate(() =>
      window.__store!.getState().setHideWorkspacesFromOtherDevices(true)
    )
    const shown = await expectPhoneMatchesSidebar(false)
    expect(shown.map((row) => path.basename(row))).toEqual(
      expect.arrayContaining(['from-desktop', 'from-phone'])
    )

    // Hide sleeping too, with a browser tab open in the desktop's workspace: only the desktop knows
    // that tab is there, so the server alone reports the workspace asleep.
    const desktopRowStatus = async () => {
      const row = (await phoneRows()).find((entry) => entry.path.endsWith('from-desktop'))
      return row ? getWorktreeStatus(toMobileRow(row)) : null
    }
    // Creation opened a terminal there; close it so only the desktop's own tab can keep it awake.
    const desktopRow = (await phoneRows()).find((entry) => entry.path.endsWith('from-desktop'))
    const worktree = `id:${desktopRow?.worktreeId ?? ''}`
    const { tabs } = TabsSchema.parse(
      (await host.client.call('session.tabs.list', { worktree })).result
    )
    for (const tab of tabs) {
      await host.client.call('session.tabs.close', { worktree, tabId: tab.id, reason: 'user' })
    }
    await expect.poll(desktopRowStatus, { timeout: 30_000 }).toBe('inactive')
    await desktop.page.evaluate(async () => {
      const state = window.__store!.getState()
      state.setShowSleepingWorkspaces(false)
      const worktree = state.allWorktrees().find((entry) => entry.path.endsWith('from-desktop'))
      if (!worktree) {
        throw new Error('the desktop does not list its own server workspace')
      }
      state.setActiveWorktree(worktree.id, worktree.hostId)
      state.setBrowserDefaultUrl('about:blank')
      await state.openNewBrowserTabInActiveWorkspace(state.activeGroupIdByWorktree[worktree.id])
    })
    // The phone's status dot and its Hide sleeping both read the desktop's view of the row.
    await expect.poll(desktopRowStatus, { timeout: 60_000 }).toBe('active')
    const awake = await expectPhoneMatchesSidebar(true)
    expect(awake.map((row) => path.basename(row))).toContain('from-desktop')
  } finally {
    await dispose()
  }
})

function toMobileRow(row: z.infer<typeof ServerRowsSchema>['worktrees'][number]): Worktree {
  return {
    worktreeId: row.worktreeId,
    repoId: row.repoId,
    repo: '',
    branch: row.branch,
    displayName: row.worktreeId,
    path: row.path,
    isMainWorktree: row.isMainWorktree,
    hasHostSidebarActivity: row.hasHostSidebarActivity,
    desktopOtherClient: row.desktopOtherClient,
    status: row.status,
    liveTerminalCount: 0,
    hasAttachedPty: false,
    unread: false,
    isPinned: false,
    linkedPR: null
  }
}
