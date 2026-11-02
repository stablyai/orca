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

function collectLinks(provider: ILinkProvider, bufferLineNumber = 1): ILink[] | undefined {
  let result: ILink[] | undefined
  let called = false
  provider.provideLinks(bufferLineNumber, (links) => {
    called = true
    result = links
  })
  expect(called).toBe(true)
  return result
}

describe('guardLinkProvider', () => {
  it('reproduces the xterm web-links RangeError without letting it escape', () => {
    // Reproduce F0BDKBHDAUE: pathological wrapped lines make LinkComputer allocate an invalid array length.
    const provider: ILinkProvider = {
      provideLinks: () => {
        throw new RangeError('Invalid array length')
      }
    }
    const guarded = guardLinkProvider(provider, 'web-links')

    expect(() => collectLinks(guarded)).not.toThrow()
    expect(collectLinks(guarded)).toBeUndefined()
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_link_provider_error',
      {
        provider: 'web-links',
        bufferLineNumber: 1,
        errorName: 'RangeError',
        errorMessage: 'Invalid array length'
      }
    )
  })

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
