import { beforeEach, describe, expect, it, vi } from 'vitest'

const runtime = vi.hoisted(() => ({ call: vi.fn() }))
vi.mock('./web-runtime-calls', () => ({ callRuntimeResult: runtime.call }))

import { createHooksApi } from './web-review-api'

// stack audit E9-6: a web client's render-driven hooks check must not open a stopped WSL distro.
describe('web hooks check', () => {
  beforeEach(() => {
    runtime.call.mockReset().mockResolvedValue({ hasHooks: false, hooks: null })
  })

  it('marks a render-driven check background, for older hosts too', async () => {
    await createHooksApi().check({ repoId: 'repo-1', background: true })

    expect(runtime.call).toHaveBeenCalledWith('repo.hooksCheck', {
      repo: 'repo-1',
      background: true
    })
  })

  it('asks for the wake explicitly only for a launch check', async () => {
    await createHooksApi().check({ repoId: 'repo-1' })

    expect(runtime.call).toHaveBeenCalledWith('repo.hooksCheck', {
      repo: 'repo-1',
      wakeWslDistro: true
    })
  })
})
