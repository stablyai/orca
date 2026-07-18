/**
 * Playwright globalTeardown: cleans up the test git repo and worktrees.
 *
 * Why: the temp repo created by globalSetup should be removed after the
 * test run so we don't litter the user's /tmp with test directories.
 */

import { cleanupE2ERunScope, resolveE2ERunScope } from './e2e-run-scope'

export default function globalTeardown(): void {
  // Why: Playwright may load setup and teardown through separate module
  // wrappers. Reconstruct from the run id in the shared process environment
  // instead of relying on a named export from the setup module.
  const cleanedPaths = cleanupE2ERunScope(resolveE2ERunScope(), {
    allowMissingManifest: true
  })
  if (cleanedPaths.length > 0) {
    console.error(`[e2e] Cleaned up ${cleanedPaths.length} run-scoped resources`)
  }
}
