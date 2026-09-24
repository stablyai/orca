import {
  expectOnlyActiveBrowserSessionProfile,
  createAndSelectBrowserSessionProfile,
  test
} from './helpers/browser-session-profile-settings'

const PROFILE_LABEL = 'Persisted Profile'

test('Settings → Browser still shows the chosen profile as Active after a relaunch', async ({
  orcaOnBrowserSettings
}) => {
  const first = await orcaOnBrowserSettings.launch()
  const profileId = await createAndSelectBrowserSessionProfile(first, PROFILE_LABEL)
  await expectOnlyActiveBrowserSessionProfile(first, profileId)

  await orcaOnBrowserSettings.quit()

  const relaunched = await orcaOnBrowserSettings.launch()
  await expectOnlyActiveBrowserSessionProfile(relaunched, profileId)
})
