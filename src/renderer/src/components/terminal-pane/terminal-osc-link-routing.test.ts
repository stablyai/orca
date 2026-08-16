import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type * as HttpLinkRouting from '@/lib/http-link-routing'
import { handleOscLink } from './terminal-osc-link-routing'

const openHttpLink = vi.fn()
// Why: spread the real module so unrelated importers (the store registers its browser
// opener at import time) keep working when only openHttpLink is stubbed.
vi.mock('@/lib/http-link-routing', async (importOriginal) => ({
  ...(await importOriginal<typeof HttpLinkRouting>()),
  openHttpLink: (...args: unknown[]) => openHttpLink(...args)
}))

const openOrcaDeepLink = vi.fn()

beforeEach(() => {
  openHttpLink.mockReset()
  openOrcaDeepLink.mockReset()
  // Why: handleOscLink forwards orca:// clicks through the preload bridge.
  vi.stubGlobal('window', {
    ...globalThis.window,
    api: { ui: { openOrcaDeepLink } }
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

const deps = { worktreeId: 'wt1', worktreePath: '/repo', startupCwd: '/repo' }
// metaKey+ctrlKey both set so direct activation passes on Mac and non-Mac runners.
const activation = { metaKey: true, ctrlKey: true }

describe('handleOscLink orca:// routing', () => {
  it('forwards an orca://focus link to the deep-link bridge', () => {
    expect(handleOscLink('orca://focus/term_abc', activation, deps)).toBe(true)
    expect(openOrcaDeepLink).toHaveBeenCalledWith('orca://focus/term_abc')
    expect(openHttpLink).not.toHaveBeenCalled()
  })

  it('does not forward when the click is not a modifier activation', () => {
    expect(handleOscLink('orca://focus/term_abc', { metaKey: false, ctrlKey: false }, deps)).toBe(
      false
    )
    expect(openOrcaDeepLink).not.toHaveBeenCalled()
  })

  it('still routes http links to the browser, not the deep-link bridge', () => {
    handleOscLink('https://example.com', activation, deps)
    expect(openHttpLink).toHaveBeenCalled()
    expect(openOrcaDeepLink).not.toHaveBeenCalled()
  })
})
