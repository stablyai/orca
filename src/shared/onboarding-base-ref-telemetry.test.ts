import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('onboarding base-ref picker telemetry schemas', () => {
  it('accepts low-cardinality picker transition payloads', () => {
    expect(
      eventSchemas.onboarding_base_ref_picker_shown.safeParse({
        path: 'open_folder',
        cohort: 'fresh_install'
      }).success
    ).toBe(true)
    expect(
      eventSchemas.onboarding_base_ref_picker_completed.safeParse({
        path: 'clone_url',
        cohort: 'upgrade_backfill'
      }).success
    ).toBe(true)
  })

  it('rejects raw branch and repo fields via .strict()', () => {
    expect(
      eventSchemas.onboarding_base_ref_picker_completed.safeParse({
        path: 'open_folder',
        branch_name: 'origin/private-customer-branch'
      }).success
    ).toBe(false)
    expect(
      eventSchemas.onboarding_base_ref_picker_shown.safeParse({
        path: 'open_folder',
        repo_name: 'private-repo'
      }).success
    ).toBe(false)
  })
})
