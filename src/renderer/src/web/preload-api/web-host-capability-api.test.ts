import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SKILL_DELETE_CAPABILITY } from '../../../../shared/skill-install-capability'
import { installBrowserGlobals } from '../web-preload-api-test-harness'

vi.mock('./web-runtime-calls', () => ({
  callRuntimeResult: vi.fn(),
  getRemoteRuntimeStatus: vi.fn(async () => ({
    capabilities: [SKILL_DELETE_CAPABILITY]
  }))
}))

describe('web skills API', () => {
  beforeEach(() => {
    vi.resetModules()
    installBrowserGlobals('Linux')
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('does not offer delete on a paired web host even when the capability is advertised', async () => {
    // Why: web-runtime-session reads window at import time.
    const { createSkillsApi } = await import('./web-host-capability-api')
    expect(await createSkillsApi().deleteSupported()).toBe(false)
  })
})
