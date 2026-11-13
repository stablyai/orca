import { describe, expect, it } from 'vitest'
import { translate as t } from '@/i18n/i18n'
import { planFeatureLine, planFeatureLines } from './plan-feature-copy'

const context = { overage: { centsPerHour: 100, defaultSpendCapCents: 2500 }, currency: 'usd' }

describe('plan feature copy', () => {
  it('localizes known ids with the catalog numbers', () => {
    expect(
      planFeatureLine(
        { id: 'included_hours_per_seat', params: { hours: 60 }, text: 'x' },
        context,
        t,
        'en-US'
      )
    ).toBe('60 sandbox hours per seat each month, pooled across your team')
    expect(
      planFeatureLine({ id: 'overage_optional', params: {}, text: 'x' }, context, t, 'en-US')
    ).toBe(
      'Optional overage at $1.00 per sandbox hour, billed by the minute, up to a monthly spend cap you set ($25 by default)'
    )
    expect(
      planFeatureLine(
        { id: 'overage_optional', params: {}, text: 'x' },
        { overage: null, currency: 'usd' },
        t,
        'en-US'
      )
    ).toBe('Optional overage up to a monthly spend cap you set')
    expect(
      planFeatureLine({ id: 'sandbox_spec', params: {}, text: 'x' }, context, t, 'en-US')
    ).toMatch(/^Every sandbox gets \d+ vCPU · \d+ GB$/)
    expect(
      planFeatureLine({ id: 'idle_sleep', params: { minutes: 15 }, text: 'x' }, context, t, 'en-US')
    ).toBe('Sleeps after 15 minutes idle, so quiet time is free')
  })

  it('never advertises egress controls, which no team can configure yet', () => {
    const egress = { id: 'egress_controls', params: {}, text: 'Network egress controls' }
    expect(planFeatureLine(egress, context, t, 'en-US')).toBeNull()
    expect(
      planFeatureLines(
        [
          { id: 'byoc', params: {}, text: 'x' },
          egress,
          { id: 'custom_limits', params: {}, text: 'x' }
        ],
        context,
        t,
        'en-US'
      )
    ).toEqual(['Run sandboxes in your own cloud account', 'Custom limits, invoicing and terms'])
  })

  it("shows billing's text for ids it does not know, or a known id missing its numbers", () => {
    expect(
      planFeatureLine(
        { id: 'gpu_sandboxes', params: {}, text: 'GPU sandboxes' },
        context,
        t,
        'en-US'
      )
    ).toBe('GPU sandboxes')
    expect(
      planFeatureLine(
        { id: 'included_hours_per_seat', params: {}, text: 'Lots of hours' },
        context,
        t,
        'en-US'
      )
    ).toBe('Lots of hours')
    expect(
      planFeatureLines([{ id: 'unknown', params: {}, text: ' ' }], context, t, 'en-US')
    ).toEqual([])
  })
})
