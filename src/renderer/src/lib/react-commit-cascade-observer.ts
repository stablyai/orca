/**
 * Installs the per-commit hook that feeds the cascade telemetry.
 *
 * Why the devtools callback and not <Profiler> or a root effect: Profiler is
 * stripped from production react-dom, and a dependency-less useLayoutEffect
 * fires per render of its OWN component, not per commit — measured, a root
 * effect saw 1 of 11 commits a leaf drove. react-dom calls onCommitFiberRoot
 * once per commit per root in both bundles, inside its own try/catch, and hands
 * us the FiberRoot whose `pendingLanes` drive the reset rule.
 *
 * Ordering: this module only WRAPS `onCommitFiberRoot`, which react-dom re-reads
 * at every commit, so it may be imported anywhere. The deadline belongs to
 * react-devtools-commit-hook-shim, which must merely exist before react-dom's
 * module evaluation and is therefore the entries' first import.
 */
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
  // Why unref where available: the check must never hold a renderer teardown open.
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
      // Why only after the assignment: a hook that refuses it stays uninstalled,
      // so a later call can retry rather than being gated out.
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
    // Why our own try/catch when react-dom already has one: theirs would
    // swallow the rest of this callback, silently unhooking DevTools and
    // Fast Refresh from the chain below.
    try {
      commitsSeen += 1
      const pendingLanes = (root as FiberRootLike | null)?.pendingLanes
      // Why 0 and not a skip: a React shape change that hides pendingLanes must
      // end the cascade, not freeze a stale depth that later commits push over
      // the limit. 0 is the lane value that means "nothing pending", so it
      // takes the same reset path and this fails safe to no crumb.
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
