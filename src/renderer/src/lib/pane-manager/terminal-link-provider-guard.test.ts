import type { ILink, ILinkProvider } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { guardLinkProvider } from './terminal-link-provider-guard'

const mocks = vi.hoisted(() => ({
  recordRendererCrashBreadcrumb: vi.fn()
}))

vi.mock('@/lib/crash-diagnostics', () => ({
  recordRendererCrashBreadcrumb: mocks.recordRendererCrashBreadcrumb
}))

beforeEach(() => {
  mocks.recordRendererCrashBreadcrumb.mockClear()
})

describe('guardLinkProvider', () => {
  it('does not double-invoke the callback when the provider throws after resolving', () => {
    const links = [{ text: 'file.ts' }] as unknown as ILink[]
    const provider: ILinkProvider = {
      provideLinks: (_lineNumber, callback) => {
        callback(links)
        throw new RangeError('Invalid array length')
      }
    }
    const guarded = guardLinkProvider(provider, 'orca-file')

    const callback = vi.fn()
    expect(() => guarded.provideLinks(1, callback)).not.toThrow()
    expect(callback).toHaveBeenCalledTimes(1)
    expect(callback).toHaveBeenCalledWith(links)
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledOnce()
  })
})
