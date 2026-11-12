import { describe, expect, it } from 'vitest'
import { planFeatureLine, planFeatureLines } from './plan-feature-copy'

// The default-value translator the renderer falls back to (interpolates {{name}}).
const t = ((_key: string, fallback: string, values?: Record<string, unknown>) =>
  fallback.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(values?.[name] ?? ''))) as never

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
