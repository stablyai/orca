import { expect, test } from './helpers/orca-app'
import { RuntimeClient } from '../../src/cli/runtime/client'
import { launchHeadlessPairedRuntimeHost } from './helpers/headless-paired-runtime-host'
import {
  launchPairedElectronClient,
  type PairedElectronClient
} from './helpers/paired-electron-client'
import {
  openClientHostedFixturePage,
  selectPairedWorktreeGroup,
  startClientHostedMarkerFixture,
  waitForPairedWorktreeId,
  waitForRenderedClientWebview
} from './helpers/client-hosted-browser-fixture'

test('switches a paired client profile while preserving isolated native cookie jars', async ({
  testRepoPath
}, testInfo) => {
  test.setTimeout(240_000)
  const fixture = await startClientHostedMarkerFixture()
  const host = await launchHeadlessPairedRuntimeHost()
  const runtime = new RuntimeClient(host.userDataDir, 30_000)
  let client: PairedElectronClient | null = null
  try {
    await runtime.call('repo.add', { path: testRepoPath, kind: 'git' })
    await runtime.call('terminal.create', {
      worktree: `path:${testRepoPath}`,
      title: 'Profile cookies'
    })
    client = await launchPairedElectronClient(host.offer, testInfo, 'Profile cookies client')
    const worktreeId = await waitForPairedWorktreeId(client.page, testRepoPath)
    await selectPairedWorktreeGroup(client.page, client.environmentId, worktreeId)
    const browser = await openClientHostedFixturePage(client, worktreeId, fixture.markerUrl)
    await waitForRenderedClientWebview(
      client.page,
      {
        urlPrefix: fixture.origin,
        remotePageId: browser.remotePageId
      },
      'profile fixture did not render'
    )
    const guestState = (cookieValue?: string) =>
      client!.app.evaluate(
        async ({ webContents }, args) => {
          const guest = webContents
            .getAllWebContents()
            .find(
              (contents) =>
                contents.getType() === 'webview' && contents.getURL().startsWith(args.origin)
            )
          if (!guest) {
            return null
          }
          if (args.cookieValue) {
            await guest.session.cookies.set({
              url: args.origin,
              name: 'profile-probe',
              value: args.cookieValue
            })
          }
          return {
            id: guest.id,
            cookies: (await guest.session.cookies.get({ url: args.origin })).map(
              (cookie) => cookie.value
            )
          }
        },
        { origin: fixture.origin, cookieValue }
      )
    const before = await guestState('default-cookie')
    expect(before?.cookies).toContain('default-cookie')
    const created = await runtime.call<{ profile: { id: string } }>('browser.profileCreate', {
      label: 'Isolated profile cookie proof',
      scope: 'isolated'
    })
    const switchTo = (profileId: string) =>
      runtime.call('browser.tabSetProfile', {
        worktree: `path:${testRepoPath}`,
        page: browser.remotePageId,
        profileId
      })
    await switchTo(created.result.profile.id)
    await expect.poll(guestState).toMatchObject({ cookies: [] })
    const isolated = await guestState('isolated-cookie')
    expect(isolated?.id).not.toBe(before?.id)
    await switchTo('default')
    await expect.poll(guestState).toMatchObject({ cookies: ['default-cookie'] })
    await switchTo(created.result.profile.id)
    await expect.poll(guestState).toMatchObject({ cookies: ['isolated-cookie'] })
  } finally {
    await client?.dispose()
    await host.dispose()
    await fixture.close()
  }
})
