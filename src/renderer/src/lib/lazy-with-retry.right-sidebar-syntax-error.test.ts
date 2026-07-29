// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isLazyChunkLoadError, loadLazyWithRetry } from './lazy-with-retry'

// Regression guard for crash report e08749bb-777c-446e-b407-5d1f154b6173 (Orca 1.4.104).
// boundary_id=right-sidebar, surface=right-sidebar, error_name=SyntaxError,
// error_message="Unexpected token ')'". component_stack: Lazy -> Suspense ->
// RightSidebarPanelContent -> ... -> RecoverableRenderErrorBoundary.
//
// The right-sidebar source-control panel is loaded via lazyWithRetry:
//   src/renderer/src/components/right-sidebar/right-sidebar-panel-content.tsx:6
//     const SourceControl = lazy(() => import('./SourceControl'))   // lazyWithRetry
//
// So the corrupt-chunk recovery IS wired in. The crash was a BLIND SPOT in that
// recovery: after the single guarded window.location.reload() has already fired
// once this session (sessionStorage 'orca:lazy-chunk-reload-attempted' === '1'),
// loadLazyWithRetry only converted the failure into a recoverable
// LazyChunkLoadError when isKnownDynamicImportFailure(error) was true. A corrupt /
// truncated chunk that parses as invalid JS rejects import() with a native
// SyntaxError whose .name is "SyntaxError" (not "ChunkLoadError") and whose
// message "Unexpected token ')'" matched NONE of the dynamic-import regexes, so
// it was re-thrown raw to the boundary and killed the right sidebar — the exact
// reported crash. The fix treats a parse-time SyntaxError as a recoverable
// corrupt-chunk failure; these tests pin that behavior.

const RELOAD_GUARD_KEY = 'orca:lazy-chunk-reload-attempted'

// The exact error the renderer received from the corrupt right-sidebar chunk.
const reportedCrashError = (): SyntaxError => new SyntaxError("Unexpected token ')'")
// An equivalent transient fetch failure, for contrast — this one DOES recover.
const equivalentFetchError = (): TypeError =>
  new TypeError('Failed to fetch dynamically imported module: file://redacted/SourceControl.js')

function spyOnReload(): ReturnType<typeof vi.fn> {
  const reload = vi.fn()
  vi.spyOn(window.location, 'reload').mockImplementation(reload)
  return reload
}

beforeEach(() => {
  vi.useFakeTimers()
  window.sessionStorage.clear()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
  try {
    window.sessionStorage.clear()
  } catch {
    // ignore
  }
})

describe('right-sidebar lazy chunk SyntaxError crash (regression)', () => {
  it('recovers a corrupt right-sidebar chunk SyntaxError instead of surfacing it to the boundary', async () => {
    const reload = spyOnReload()
    // The one guarded reload already happened earlier this session: the user has
    // navigated/reloaded once after the stale chunk was first hit.
    window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')

    // import('./SourceControl') rejects with the native parse error from the
    // corrupt chunk — exactly what the crash report captured.
    const factory = vi.fn(() => Promise.reject(reportedCrashError()))

    const loaded = loadLazyWithRetry(factory, { retries: 2, reloadKey: 'right-sidebar' })
    // Drain the retry backoff timers first (fake timers), THEN await the result.
    const settled = loaded.then(
      () => null,
      (error: unknown) => error
    )
    await vi.advanceTimersByTimeAsync(5000)
    const caught = await settled

    // A corrupt-chunk parse failure is unrecoverable-by-retry, so it must be
    // wrapped as a recoverable LazyChunkLoadError, NOT re-thrown raw to the
    // RecoverableRenderErrorBoundary where its only "Retry" re-runs the same dead
    // import. With the fix, the parse-time SyntaxError is recovered.
    expect(reload).not.toHaveBeenCalled() // guard already set: no second reload
    expect(isLazyChunkLoadError(caught)).toBe(true)
  })

  it('treats the corrupt chunk SyntaxError the same as an equivalent fetch failure', async () => {
    // Demonstrates the blind spot is purely error-shape gating: the SAME corrupt
    // chunk, surfaced as a fetch failure, IS recovered; surfaced as a parse error,
    // it is not. Both are the same unrecoverable corrupt right-sidebar chunk.
    const recover = async (makeError: () => Error): Promise<unknown> => {
      window.sessionStorage.setItem(RELOAD_GUARD_KEY, '1')
      const factory = vi.fn(() => Promise.reject(makeError()))
      const loaded = loadLazyWithRetry(factory, { retries: 0, reloadKey: 'right-sidebar' })
      try {
        await loaded
        return null
      } catch (error) {
        return error
      } finally {
        await vi.advanceTimersByTimeAsync(5000)
        window.sessionStorage.clear()
      }
    }

    spyOnReload()
    const fetchOutcome = await recover(equivalentFetchError)
    const parseOutcome = await recover(reportedCrashError)

    expect(isLazyChunkLoadError(fetchOutcome)).toBe(true) // recovered
    // The parse error from the very same corrupt chunk must be recovered too.
    expect(isLazyChunkLoadError(parseOutcome)).toBe(true)
  })
})
