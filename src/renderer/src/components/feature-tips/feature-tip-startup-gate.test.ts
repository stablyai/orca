import { afterEach, expect, it, vi } from 'vitest'
import { createGlobalSettingsFixture } from '../../../../shared/global-settings-test-fixture'
import { getDefaultVoiceSettings } from '../../../../shared/constants'
import { useAppStore } from '../../store'
import { getPendingFeatureTips } from './feature-tip-startup-gate'

afterEach(() => {
  useAppStore.setState(useAppStore.getInitialState(), true)
  vi.unstubAllGlobals()
})

it('offers the rollout after historical completion and consumes only its own exposure', () => {
  vi.stubGlobal('window', { api: { ui: { set: vi.fn().mockResolvedValue(undefined) } } })
  const settings = createGlobalSettingsFixture({
    voice: { ...getDefaultVoiceSettings(), enabled: true },
    aiVaultSearch: { enabled: true, historyDays: null },
    telemetry: {
      optedIn: true,
      installId: 'install',
      existedBeforeTelemetryRelease: true,
      chatUiLaunchTipCohort: 'control',
      chatUiLaunchTipRolloutCohort: 'treatment'
    }
  })
  useAppStore.setState({
    settings,
    featureTipsSeenIds: ['chat-ui-here', 'cmd-j-palette']
  })
  const pendingTipIds = () =>
    getPendingFeatureTips({
      seenTipIds: useAppStore.getState().featureTipsSeenIds,
      cliInstalled: true,
      featureInteractions: {},
      chatUiLaunchTipVariant: 'chat-ui-off',
      settings,
      webClient: false
    }).map((tip) => tip.id)

  expect(pendingTipIds()).toEqual(['chat-ui-here'])
  useAppStore.getState().markFeatureTipsSeen(['chat-ui-here'])
  expect(useAppStore.getState().featureTipsSeenIds).toEqual([
    'chat-ui-here',
    'cmd-j-palette',
    'chat-ui-here-rollout-v1'
  ])
  expect(pendingTipIds()).toEqual([])
})
