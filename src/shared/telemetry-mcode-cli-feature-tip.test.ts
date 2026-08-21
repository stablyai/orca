import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('mcode cli feature tip schemas', () => {
  it('accepts the shown event for app-open exposure', () => {
    const parsed = eventSchemas.mcode_cli_feature_tip_shown.safeParse({
      source: 'app_open'
    })

    expect(parsed.success).toBe(true)
  })

  it('accepts setup click and setup result events', () => {
    expect(
      eventSchemas.mcode_cli_feature_tip_setup_clicked.safeParse({
        source: 'app_open'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.mcode_cli_feature_tip_setup_result.safeParse({
        source: 'app_open',
        result: 'installed'
      }).success
    ).toBe(true)
  })

  it('rejects raw CLI details and unknown result values', () => {
    expect(
      eventSchemas.mcode_cli_feature_tip_setup_result.safeParse({
        source: 'app_open',
        result: 'installed',
        command_path: '/Users/alice/bin/mcode'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.mcode_cli_feature_tip_setup_result.safeParse({
        source: 'app_open',
        result: 'installed_after_retry'
      }).success
    ).toBe(false)
  })
})
