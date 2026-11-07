import { describe, expect, it, vi } from 'vitest'
import { ORCA_BROWSER_BLANK_URL } from '../../../../shared/constants'

const mocks = vi.hoisted(() => ({
  createWebRuntimeSessionBrowserTab: vi.fn(async (_args: Record<string, unknown>) => true)
}))

vi.mock('@/runtime/web-runtime-browser-creation', () => ({
  createWebRuntimeSessionBrowserTab: mocks.createWebRuntimeSessionBrowserTab
}))

import { resolveBrowserReopenOnServerUrl } from './browser-reopen-on-server'

describe('resolveBrowserReopenOnServerUrl', () => {
  it('reopens blank rather than replaying something the new engine cannot restore', () => {
    expect(resolveBrowserReopenOnServerUrl(ORCA_BROWSER_BLANK_URL)).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl('about:blank')).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl('file:///etc/hosts')).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl('')).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl(null)).toBeUndefined()
    expect(resolveBrowserReopenOnServerUrl(undefined)).toBeUndefined()
  })
})
