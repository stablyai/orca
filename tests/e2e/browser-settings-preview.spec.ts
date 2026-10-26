// Opt-in Settings → Browser preview; enable with ORCA_SETTINGS_PREVIEW=1.
import { expect, test } from './helpers/orca-app'

test.skip(
  process.env.ORCA_SETTINGS_PREVIEW !== '1',
  'Preview only; run with ORCA_SETTINGS_PREVIEW=1'
)

const HOLD_MINUTES = 20

test('shows the remote browsing settings section and holds for review', async ({
  electronApp,
  orcaPage
}) => {
  test.setTimeout((HOLD_MINUTES + 10) * 60_000)

  await electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0]
    window?.setSize(1440, 900)
    window?.center()
    window?.show()
    window?.focus()
  })

  // Seed one opted-out SSH host so the "Route again" list renders too.
  await orcaPage.evaluate(() => {
    const state = window.__store?.getState()
    state?.updateSettings({ browserSshWorkspaceRoutingDisabledTargetIds: ['preview-target'] })
    window.__store?.setState({
      sshTargetLabels: new Map([['preview-target', 'openclaw']])
    } as never)
    state?.openSettingsTarget({
      pane: 'browser',
      repoId: null,
      sectionId: 'browser-ssh-workspace-routing'
    })
    state?.openSettingsPage()
  })

  await expect(orcaPage.getByText('Remote browsing', { exact: true })).toBeVisible({
    timeout: 30_000
  })

  console.log(`\n=== SETTINGS PREVIEW READY — window stays up ${HOLD_MINUTES} minutes ===\n`)
  await orcaPage.waitForTimeout(HOLD_MINUTES * 60_000)
})
