// H5c-v: with ORCA_LAYOUT_OWNER=main, layout.reportView must send the desktop’s shown group so server CLI file-open lands there, independent of saved server selection.
import { existsSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { HOST_TERMINAL_SURFACE_SEPARATOR } from '../../src/shared/terminal-surface-id'
import { LAYOUT_INTENTS_RUNTIME_CAPABILITY } from '../../src/shared/workspace-layout/layout-intents-capability'
import type { PublishedWorkspaceLayout } from '../../src/shared/workspace-layout/workspace-layout-published'
import { expect, test } from './helpers/orca-app'
import { readServerLayout } from './helpers/paired-desktop-server-layout'
import {
  launchHeadlessPairedRuntimeHost,
  type HeadlessPairedRuntimeHost
} from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'

const LAYOUT_OWNER_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'ORCA_LAYOUT_OWNER_MAIN')
)

function groupOfTab(layout: PublishedWorkspaceLayout | null, tabId: string): string | null {
  return layout?.groups.find((group) => group.tabIds.includes(tabId))?.id ?? null
}

/** The group holding the editor tab of `fileName`; null while the server has none. */
function groupOfFile(layout: PublishedWorkspaceLayout | null, fileName: string): string | null {
  const tab = layout?.tabs.find(
    (entry) =>
      entry.kind === 'editor' && decodeURIComponent(entry.entityId).endsWith(`/${fileName}`)
  )
  return tab ? groupOfTab(layout, tab.id) : null
}

async function waitForWorktree(host: HeadlessPairedRuntimeHost, repoId: string): Promise<string> {
  let worktreeId = ''
  await expect
    .poll(
      async () => {
        const listed = await host.client.call<{ worktrees: { id: string }[] }>('worktree.list', {
          repo: `id:${repoId}`
        })
        worktreeId = listed.result.worktrees[0]?.id ?? ''
        return worktreeId
      },
      { timeout: 30_000, message: 'Serve host never listed its folder workspace' }
    )
    .not.toBe('')
  return worktreeId
}

async function createServerTerminal(
  host: HeadlessPairedRuntimeHost,
  worktreeId: string
): Promise<string> {
  const created = await host.client.call<{ tab: { id: string } }>('session.tabs.createTerminal', {
    worktree: `id:${worktreeId}`,
    activate: false,
    select: false,
    navigation: 'caller'
  })
  return created.result.tab.id.split(HOST_TERMINAL_SURFACE_SEPARATOR)[0]!
}

/** Shows the server workspace on the desktop and waits until its frames draw `groupIds`. */
async function showFrameDrawnWorkspace(
  client: PairedElectronClient,
  worktreeId: string,
  groupIds: string[]
): Promise<void> {
  await expect
    .poll(
      () =>
        client.page.evaluate(
          ({ environmentId, worktreeId }) => {
            const state = window.__store?.getState()
            if (!state?.allWorktrees().some((worktree) => worktree.id === worktreeId)) {
              return 'unlisted'
            }
            if (state.activeWorktreeId !== worktreeId) {
              state.setActiveView('terminal')
              state.setActiveWorktree(worktreeId, `runtime:${environmentId}`)
            }
            const drawn = window.__isFrameDrawnServerWorkspaceE2E?.(environmentId, worktreeId)
            return drawn
              ? (state.groupsByWorktree[worktreeId] ?? []).map((group) => group.id)
              : 'not frame-drawn'
          },
          { environmentId: client.environmentId, worktreeId }
        ),
      { timeout: 90_000, message: 'The desktop never drew both server groups from frames' }
    )
    .toEqual(groupIds)
}

async function showGroupOnDesktop(
  client: PairedElectronClient,
  worktreeId: string,
  groupId: string
): Promise<void> {
  await client.page.evaluate(
    ({ worktreeId, groupId }) => window.__store!.getState().focusGroup(worktreeId, groupId),
    { worktreeId, groupId }
  )
  await expect
    .poll(() =>
      client.page.evaluate(
        (id) => window.__store!.getState().activeGroupIdByWorktree[id] ?? null,
        worktreeId
      )
    )
    .toBe(groupId)
}

test.describe('a file opened on a switch-on server lands in the group a paired desktop shows', () => {
  test.skip(!LAYOUT_OWNER_BUILD, 'Needs a layout-owner build (ORCA_LAYOUT_OWNER=main)')

  test('each CLI open follows the group the desktop switched to', async ({
    testRepoPath
  }, testInfo) => {
    test.setTimeout(300_000)
    const host = await launchHeadlessPairedRuntimeHost()
    let client: PairedElectronClient | null = null
    try {
      const status = await host.client.call<{ capabilities?: string[] }>('status.get')
      expect(status.result.capabilities ?? []).toContain(LAYOUT_INTENTS_RUNTIME_CAPABILITY)

      const added = await host.client.call<{ repo: { id: string } }>('repo.add', {
        path: testRepoPath,
        kind: 'folder'
      })
      const worktreeId = await waitForWorktree(host, added.result.repo.id)
      const firstTab = await createServerTerminal(host, worktreeId)
      const secondTab = await createServerTerminal(host, worktreeId)
      let groupA: string | null = null
      await expect
        .poll(async () => (groupA = groupOfTab(await readServerLayout(host, worktreeId), firstTab)))
        .not.toBeNull()
      // Two groups: the second terminal moves into a new group beside the first.
      await host.client.call('layout.apply', {
        command: {
          type: 'splitGroup',
          workspace: worktreeId,
          tabId: secondTab,
          besideGroupId: groupA,
          direction: 'right'
        }
      })
      let groups: string[] = []
      await expect
        .poll(async () => {
          const layout = await readServerLayout(host, worktreeId)
          groups = layout?.groups.map((group) => group.id) ?? []
          const split =
            groups.length === 2 &&
            groupOfTab(layout, firstTab) === groups[0] &&
            groupOfTab(layout, secondTab) === groups[1]
          return split ? 'split' : { groups, layout }
        })
        .toBe('split')

      client = await launchPairedElectronClient(host.offer, testInfo, 'server-file-open-group')
      const desktop = client
      await showFrameDrawnWorkspace(desktop, worktreeId, groups)

      // Both groups in turn: whichever one the server's saved view names, the other proves the report.
      for (const [index, target] of [groups[1]!, groups[0]!, groups[1]!].entries()) {
        await test.step(`the desktop shows group ${index === 1 ? 'A' : 'B'}; a CLI open lands there`, async () => {
          await showGroupOnDesktop(desktop, worktreeId, target)
          // A fresh file per try: the report is fire-and-forget, so the server may not have it yet.
          let attempt = 0
          await expect
            .poll(
              async () => {
                const fileName = `h5cv-${index}-${attempt++}.txt`
                writeFileSync(path.join(testRepoPath, fileName), `${fileName}\n`)
                await host.client.call('files.open', {
                  worktree: `id:${worktreeId}`,
                  relativePath: fileName
                })
                let landed: string | null = null
                await expect
                  .poll(
                    async () =>
                      (landed = groupOfFile(await readServerLayout(host, worktreeId), fileName)),
                    { timeout: 15_000 }
                  )
                  .not.toBeNull()
                return landed
              },
              {
                timeout: 30_000,
                intervals: [1_000],
                message: 'The CLI-opened file never landed in the group the desktop shows'
              }
            )
            .toBe(target)
        })
      }
    } finally {
      await client?.dispose()
      await host.dispose()
    }
  })
})
