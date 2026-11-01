// Compare real phone feed/list modules over a paired socket to rendered desktop SSH rows, including host section and active highlight.
import type { Page } from '@stablyai/playwright-test'
import { expect, test } from './helpers/orca-app'
import { toRuntimeExecutionHostId } from '../../src/shared/execution-host'
import {
  launchManagedWorkspace,
  skipUnlessManagedDockerHost,
  withManagedHost
} from './helpers/orcad-managed-workspace'
import { createDesktopMobilePairingOffer } from './helpers/paired-electron-client'
import { pairMobileClient } from './helpers/paired-mobile-client'
import {
  desktopSidebarOutline,
  outlineRows,
  openPhoneFeedList,
  type ListOutline
} from './helpers/phone-feed-list'
import { SIDEBAR_INPUTS_BUILD } from './helpers/sidebar-inputs-build'

skipUnlessManagedDockerHost()
test.skip(
  !SIDEBAR_INPUTS_BUILD,
  'the phone reads the feed only in an ORCA_SIDEBAR_INPUTS=main build'
)

type PhoneList = Awaited<ReturnType<typeof openPhoneFeedList>>

/** Both sides inside one poll: either may still be catching up with the last change. */
async function expectPhoneMatchesDesktop(page: Page, phone: PhoneList): Promise<ListOutline> {
  let desktop: ListOutline = []
  let shown: ListOutline = []
  await expect
    .poll(
      async () => {
        desktop = await desktopSidebarOutline(page)
        shown = await phone.outline()
        return outlineRows(shown).join('\n') === outlineRows(desktop).join('\n')
      },
      { timeout: 60_000 }
    )
    .toBe(true)
    .catch(() => expect(outlineRows(shown)).toEqual(outlineRows(desktop)))
  return shown
}

test("the phone lists the desktop's managed SSH workspace as the desktop sidebar does", async (// oxlint-disable-next-line no-empty-pattern -- This exercise owns its app launch.
{}, testInfo) => {
  test.setTimeout(12 * 60_000)
  await withManagedHost(testInfo, async (fixture) => {
    const { page, seeded, environmentId } = await launchManagedWorkspace(fixture)
    const sshRow = (outline: ListOutline): string[] =>
      outline.filter((line) => line.startsWith('ITEM ') && line.includes(seeded.repoPath))
    // The desktop draws the SSH workspace before the phone is asked to match it.
    await expect
      .poll(async () => sshRow(await desktopSidebarOutline(page)), { timeout: 120_000 })
      .toHaveLength(1)

    const phone = pairMobileClient(await createDesktopMobilePairingOffer(page))
    // The phone last opened the seeded workspace, on its managed server, so it highlights that row.
    const list = await openPhoneFeedList(phone, {
      worktreeId: seeded.worktreeId,
      executionHost: toRuntimeExecutionHostId(environmentId)
    })
    try {
      const shown = await expectPhoneMatchesDesktop(page, list)
      expect(sshRow(shown)).toEqual([expect.stringMatching(/ ACTIVE$/)])
      expect(shown.filter((line) => line.endsWith(' ACTIVE'))).toHaveLength(1)
    } finally {
      list.close()
      phone.dispose()
    }
  })
})
