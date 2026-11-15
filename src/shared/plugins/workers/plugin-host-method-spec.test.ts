import { describe, expect, it } from 'vitest'
import { z } from 'zod'
import { pluginHostMethodNewestMinorFor, spec, WORKER_ONLY } from './plugin-host-method-spec'

const base = {
  summary: 'test',
  since: 2,
  scope: 'desktop',
  capability: null,
  mutation: false,
  surfaces: WORKER_ONLY,
  params: z.strictObject({ workspaceId: z.string().optional() }),
  result: z.object({})
} as const

describe('pluginHostMethodNewestMinorFor', () => {
  it('counts a param added after the method, so a plugin can require it through api.minor', () => {
    expect(pluginHostMethodNewestMinorFor(spec(base), 'worker')).toBe(2)
    expect(
      pluginHostMethodNewestMinorFor(spec({ ...base, paramsSince: { workspaceId: 10 } }), 'worker')
    ).toBe(10)
  })
})
