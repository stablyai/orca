/** Use onCommitFiberRoot in both React bundles: production strips Profiler and root effects miss leaf commits. Wrap any time because React rereads the callback; only the import-free hook shim must precede react-dom evaluation. */
import { observeReactCommit } from '@/lib/react-commit-cascade-telemetry'
import { recordRendererCrashBreadcrumb } from '@/lib/crash-breadcrumb-recorder'
import {
  ensureReactDevtoolsCommitHook,
  type ReactDevtoolsCommitHook
} from '@/lib/react-devtools-commit-hook-shim'

export const REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB = 'react_commit_cascade_uninstalled'

/** Long enough that any live renderer has committed; short enough to reach a crash report. */
export const REACT_COMMIT_CASCADE_INSTALL_CHECK_MS = 10_000

type FiberRootLike = { pendingLanes?: unknown }

let installed = false
let commitsSeen = 0
let installCheckTimer: ReturnType<typeof setTimeout> | undefined

/**
 * A reshuffled import or a bundler hoist would disable the diagnostic with no
 * test failure. Make that visible in the field instead of silent.
 */
function scheduleInstallSelfCheck(): void {
  if (installCheckTimer !== undefined || typeof setTimeout !== 'function') {
    return
  }
  installCheckTimer = setTimeout(() => {
    if (commitsSeen === 0) {
      recordRendererCrashBreadcrumb(REACT_COMMIT_CASCADE_UNINSTALLED_BREADCRUMB)
    }
  }, REACT_COMMIT_CASCADE_INSTALL_CHECK_MS)
  // Unref where supported so diagnostics never hold renderer teardown open.
  ;(installCheckTimer as { unref?: () => void })?.unref?.()
}

export function installReactCommitCascadeObserver(): void {
  if (installed) {
    return
  }
  try {
    const hook = ensureReactDevtoolsCommitHook()
    if (hook) {
      installObserverOnHook(hook)
      // Mark installed only after assignment succeeds so failed hooks remain retryable.
      installed = true
    }
  } catch {
    // A renderer without a patchable global still has to boot.
  }
  // Why outside the try: a failed install is exactly when the crumb matters.
  scheduleInstallSelfCheck()
}

function installObserverOnHook(hook: ReactDevtoolsCommitHook): void {
  const previous = hook.onCommitFiberRoot
  // Fixed arity, not rest args: this runs on every commit and must not allocate.
  hook.onCommitFiberRoot = (rendererId, root, priorityLevel, didError) => {
    // Catch locally or React’s outer catch skips the remaining DevTools/Fast Refresh callbacks.
    try {
      commitsSeen += 1
      const pendingLanes = (root as FiberRootLike | null)?.pendingLanes
      // Missing pendingLanes resets through zero instead of freezing stale depth; diagnostics must go quiet on React shape changes.
      observeReactCommit(root, typeof pendingLanes === 'number' ? pendingLanes : 0)
    } catch {
      // Best-effort crash evidence only.
    }
    previous?.call(hook, rendererId, root, priorityLevel, didError)
  }
}

export function resetReactCommitCascadeObserverForTests(): void {
  installed = false
  commitsSeen = 0
  if (installCheckTimer !== undefined) {
    clearTimeout(installCheckTimer)
    installCheckTimer = undefined
  }
}

installReactCommitCascadeObserver()
