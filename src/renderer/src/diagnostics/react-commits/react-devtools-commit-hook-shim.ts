/** Install the hook before react-dom’s one-time global lookup. Keep this import-free so transitive dependencies cannot outrun it or import breadcrumbs ahead of test mocks; observer wrapping can happen later because React rereads callbacks each commit. */

/** Expose only required callbacks; React typeof-guards omitted optional ones, including onCommitFiberUnmount called on every deleted fiber. */
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

// Use indexed typing: bippy already augments this global with a narrower callback signature.
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
    // react-refresh calls captured onCommitFiberRoot.apply without checking for undefined.
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
