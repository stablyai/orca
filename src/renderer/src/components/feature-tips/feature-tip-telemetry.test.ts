import { expect, it, vi } from 'vitest'
import { shouldSuppressAutomaticChatUiLaunchTip } from './feature-tip-telemetry'

vi.mock('@/lib/telemetry', () => ({ track: vi.fn() }))

it('delivers to chat-default users in all targeting while holding out not-switched users', () => {
  const telemetry = {
    optedIn: true,
    installId: 'install',
    existedBeforeTelemetryRelease: true,
    chatUiLaunchTipRolloutCohort: 'treatment' as const
  }
  expect(
    shouldSuppressAutomaticChatUiLaunchTip({
      agentDefaultSurface: 'chat',
      telemetry: { ...telemetry, chatUiLaunchTipTargeting: { mode: 'all' } }
    })
  ).toBe(false)
  expect(
    shouldSuppressAutomaticChatUiLaunchTip({
      agentDefaultSurface: 'chat',
      telemetry: {
        ...telemetry,
        chatUiLaunchTipTargeting: { mode: 'not-switched', eligible: false }
      }
    })
  ).toBe(true)
})
