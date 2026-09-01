import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installApi } from '../web-preload-api-test-harness'
import { resolvePackageJsonDependencyHover } from '../../components/editor/package-json-dependency-hover-resolution'
import type { PackageJsonDependencyHoverContext } from '../../components/editor/package-json-dependency-hover-context'

// Why: obs #2754 amends `sdd/package-json-dependency-hover/spec` (obs #2743) —
// on Orca web, `window.api.npmPackageInfo` is never literally `undefined`.
// `withFallback` wraps every unimplemented domain in a real `createFallbackProxy`
// object; only *invoking* `.lookup(...)` resolves to `undefined`, via
// `getFallbackResult`'s default branch. The prior test coverage
// (`package-json-dependency-hover-resolution.test.ts`) only injected a fake
// `lookupPackageInfo: async () => undefined` and never drove the real proxy
// chain. These tests exercise the actual `createWebPreloadApi()` /
// `withFallback` / `createFallbackProxy` composition end to end.
const TEXT = '{\n  "dependencies": {\n    "react": "19.0.0"\n  }\n}\n'
const REACT_KEY_OFFSET = TEXT.indexOf('react') + 1

const CONTEXT: PackageJsonDependencyHoverContext = {
  worktreeRoot: '/repo',
  relativePath: 'package.json',
  filePath: '/repo/package.json',
  worktreeId: 'repo-1::/repo',
  connectionId: null,
  executionHostId: 'local'
}

describe('web fallback proxy chain — npmPackageInfo (real createFallbackProxy/getFallbackResult)', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('resolves `npmPackageInfo` to a real Proxy object (never `undefined`), while invoking `.lookup(...)` on it resolves to `undefined`', async () => {
    const { api } = await installApi()

    // Half 1a: the domain itself is a real value, not `undefined` —
    // `withFallback`'s `get` trap returns
    // `createFallbackProxy([...path, 'npmPackageInfo'])` for any property
    // absent from the concrete web API surface. `createFallbackProxy` wraps a
    // callable (`typeof` reports `'function'`, not `'object'`) so nested
    // member access and invocation both keep working — that callable-ness is
    // exactly what lets `.lookup(...)` be called below.
    expect(api.npmPackageInfo).not.toBeUndefined()
    expect(typeof api.npmPackageInfo).toBe('function')

    // Half 1b: invoking `.lookup(...)` on that real proxy goes through the
    // real `apply` trap → `getFallbackResult(['npmPackageInfo', 'lookup'], args)`,
    // which falls through to the default `Promise.resolve(undefined)` branch —
    // this is genuine production code, no fake/mock in this path.
    const result = await api.npmPackageInfo.lookup({
      packageName: 'react',
      executionHostId: CONTEXT.executionHostId
    })

    expect(result).toBeUndefined()
  })

  it('feeds the real fallback-proxy lookup into resolvePackageJsonDependencyHover and folds it into lookup-disabled, keeping the installed version visible', async () => {
    const { api } = await installApi()

    const result = await resolvePackageJsonDependencyHover({
      modelText: TEXT,
      offset: REACT_KEY_OFFSET,
      isCancelled: () => false,
      resolveContext: () => CONTEXT,
      resolveInstalledVersion: async () => ({ status: 'installed', version: '19.0.0' }),
      // Same wiring as production: `monaco-package-json-dependency-hover.ts`
      // passes `(request) => window.api.npmPackageInfo.lookup(request)`.
      lookupPackageInfo: (request) => api.npmPackageInfo.lookup(request)
    })

    expect(result).not.toBeNull()
    expect(result?.markdown).toContain('19.0.0')
  })
})
