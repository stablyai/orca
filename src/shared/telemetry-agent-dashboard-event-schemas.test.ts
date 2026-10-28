import { describe, expect, it } from 'vitest'
import { eventSchemas } from './telemetry-events'

describe('Agent Dashboard telemetry schemas', () => {
  it('accepts only the adoption and rendered-surface payloads', () => {
    expect(eventSchemas.agent_dashboard_enabled.safeParse({ enabled: true }).success).toBe(true)
    expect(eventSchemas.agent_dashboard_opened.safeParse({ surface: 'popout' }).success).toBe(true)
    expect(eventSchemas.agent_dashboard_opened.safeParse({ surface: 'in_window' }).success).toBe(
      true
    )
    expect(eventSchemas.agent_dashboard_active.safeParse({ surface: 'popout' }).success).toBe(true)
    expect(eventSchemas.agent_dashboard_active.safeParse({ surface: 'in_window' }).success).toBe(
      true
    )
  })

  it('rejects unbounded or ambiguous dashboard telemetry', () => {
    expect(eventSchemas.agent_dashboard_enabled.safeParse({}).success).toBe(false)
    expect(eventSchemas.agent_dashboard_opened.safeParse({ surface: 'sidebar' }).success).toBe(
      false
    )
    expect(
      eventSchemas.agent_dashboard_opened.safeParse({ surface: 'popout', card: 'task' }).success
    ).toBe(false)
    expect(eventSchemas.agent_dashboard_active.safeParse({ surface: 'sidebar' }).success).toBe(
      false
    )
    expect(
      eventSchemas.agent_dashboard_active.safeParse({ surface: 'popout', day: 123 }).success
    ).toBe(false)
  })
})
