/**
 * Guarantees __REACT_DEVTOOLS_GLOBAL_HOOK__ exists, and nothing else.
 *
 * Split out from the observer because the two halves have different deadlines:
 * react-dom reads this global ONCE, at its own module evaluation, so a fresh
 * shim must beat that import — but wrapping `onCommitFiberRoot` can happen at
 * any time, since react-dom re-reads the property at every commit. This module
 * therefore installs itself on import and has NO imports of its own, so a bare
 * side-effect import cannot be outrun by a transitive graph that reaches
 * react-dom, and cannot drag the breadcrumb recorder in ahead of any vi.mock.
 */

/**
 * Only what react-dom and react-refresh require. onCommitFiberUnmount,
 * onPostCommitFiberRoot and setStrictMode are deliberately absent: react-dom
 * guards each with a typeof check, and calls onCommitFiberUnmount once per
 * DELETED FIBER, which is genuinely hot when terminal panes unmount.
 */
export type ReactDevtoolsCommitHook = {
  isDisabled?: boolean
  supportsFiber?: boolean
  renderers?: Map<number, unknown>
  inject?: (renderer: unknown) => number
  onCommitFiberRoot?: (
    rendererId: number,
    root: unknown,
    priorityLevel: unknown,
    didError: boolean
  ) => void
}

// Indexed, not a global augmentation: bippy (a react-grab dependency) already
// declares this global with a narrower callback signature.
type GlobalWithReactDevtoolsHook = Record<string, ReactDevtoolsCommitHook | undefined>

function createCommitHookShim(): ReactDevtoolsCommitHook {
  const renderers = new Map<number, unknown>()
  return {
    isDisabled: false,
    supportsFiber: true,
    renderers,
    inject: (renderer) => {
      const rendererId = renderers.size + 1
      renderers.set(rendererId, renderer)
      return rendererId
    },
    // Why a noop and not undefined: react-refresh captures this property and
    // calls oldOnCommitFiberRoot.apply(this, arguments) with no typeof guard.
    onCommitFiberRoot: () => {}
  }
}

/** Returns the existing hook untouched, or installs a minimal one. */
export function ensureReactDevtoolsCommitHook(): ReactDevtoolsCommitHook | undefined {
  try {
    const globalWithHook = globalThis as unknown as GlobalWithReactDevtoolsHook
    const existing = globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__
    if (existing) {
      return existing
    }
    const hook = createCommitHookShim()
    globalWithHook.__REACT_DEVTOOLS_GLOBAL_HOOK__ = hook
    return hook
  } catch {
    // A renderer without a patchable global still has to boot.
    return undefined
  }
}

ensureReactDevtoolsCommitHook()
