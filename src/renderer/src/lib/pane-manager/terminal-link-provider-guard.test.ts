import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  guardLinkProvider,
  installGuardedLinkProviderRegistration
} from './terminal-link-provider-guard'

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
    // Why: this is the F0BDKBHDAUE crash — LinkComputer._getWindowedLineStrings
    // allocates an array of invalid length on a pathological wrapped line.
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

  it('passes provided links through unchanged when the provider succeeds', () => {
    const links = [{ text: 'term_abc' }] as unknown as ILink[]
    const provider: ILinkProvider = {
      provideLinks: (_lineNumber, callback) => callback(links)
    }
    const guarded = guardLinkProvider(provider, 'orca-handle')

    expect(collectLinks(guarded)).toBe(links)
    expect(mocks.recordRendererCrashBreadcrumb).not.toHaveBeenCalled()
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

describe('installGuardedLinkProviderRegistration', () => {
  it('guards every provider registered after install (addon-internal included)', () => {
    const registered: ILinkProvider[] = []
    const terminal = {
      registerLinkProvider: (provider: ILinkProvider) => {
        registered.push(provider)
        return { dispose: vi.fn() }
      }
    } as unknown as Terminal

    installGuardedLinkProviderRegistration(terminal)

    // Simulate the web-links addon's loadAddon -> registerLinkProvider path.
    terminal.registerLinkProvider({
      provideLinks: () => {
        throw new RangeError('Invalid array length')
      }
    })

    expect(registered).toHaveLength(1)
    expect(() => collectLinks(registered[0])).not.toThrow()
    expect(collectLinks(registered[0])).toBeUndefined()
    expect(mocks.recordRendererCrashBreadcrumb).toHaveBeenCalledWith(
      'terminal_link_provider_error',
      expect.objectContaining({ provider: 'provider-1', errorName: 'RangeError' })
    )
  })
})
