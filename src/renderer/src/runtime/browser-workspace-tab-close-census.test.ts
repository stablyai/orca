import { readdirSync, readFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { describe, expect, it } from 'vitest'

// Why: who tears a browser workspace down is a policy, and every close site that decides it alone
// gets it wrong in a different way — the ambiguous multi-owner close fell through silently, the
// pageless host mirror was un-closable, and the menu's Close Tab fired at a host that had never
// heard of a staged tab. Testing planBrowserWorkspaceTabClose in isolation cannot catch the next
// site that skips it, so this census pins every renderer file that closes a browser workspace:
// how often it reaches for the store action, and whether it asks the shared plan first. Adding a
// close anywhere fails this test until it is classified here.
const BROWSER_WORKSPACE_CLOSE_SITES: {
  path: string
  /**
   * Every mention of the identifier, not just call expressions: a renamed destructure or a
   * `store['closeBrowserTab']` lookup is still a close site, and matching `closeBrowserTab(`
   * walks straight past both.
   */
  closeBrowserTabMentions: number
  /** How many local teardowns forward the plan's cleanup reason; 0 for sites that skip the plan. */
  planReasonForwardings: number
  /** How many closeBrowserTab calls actually pass that reason on; 0 for sites that skip the plan. */
  reasonCarryingCloseCalls: number
  routesThroughPlan: boolean
  why: string
}[] = [
  {
    path: 'src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-lifecycle.ts',
    closeBrowserTabMentions: 4,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Mirrors a page the host already retired; a plan-driven close would echo it back.'
  },
  {
    path: 'src/renderer/src/components/floating-terminal/use-floating-terminal-close-actions.ts',
    closeBrowserTabMentions: 6,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Floating workspace tabs are local-only and have no remote owner to reconcile.'
  },
  {
    path: 'src/renderer/src/components/floating-terminal/use-floating-terminal-panel-store-state.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Passes the local floating-panel close action through its controller.'
  },
  {
    path: 'src/renderer/src/components/tab-group/useTabGroupTabCloseCommands.ts',
    closeBrowserTabMentions: 4,
    reasonCarryingCloseCalls: 1,
    planReasonForwardings: 1,
    routesThroughPlan: true,
    why: 'closeBrowserItem, shared by the split-pane strip X and bulk close commands.'
  },
  {
    path: 'src/renderer/src/components/use-terminal-bulk-close-actions.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 1,
    planReasonForwardings: 1,
    routesThroughPlan: true,
    why: 'Bulk terminal-tab teardown plans browser ownership before local cleanup.'
  },
  {
    path: 'src/renderer/src/components/use-terminal-close-actions.ts',
    closeBrowserTabMentions: 4,
    reasonCarryingCloseCalls: 2,
    planReasonForwardings: 1,
    routesThroughPlan: true,
    why: 'Terminal close callbacks route browser ownership through the shared plan.'
  },
  {
    path: 'src/renderer/src/components/use-terminal-keyboard-shortcuts.ts',
    closeBrowserTabMentions: 2,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Keyboard shortcut wiring forwards the local close action.'
  },
  {
    path: 'src/renderer/src/components/use-terminal-workspace-store-bindings.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Store binding exposes the close action to terminal controllers.'
  },
  {
    path: 'src/renderer/src/hooks/ipc-events/browser-request-ipc-bridge.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Host-requested closes are applied locally without echoing a close request.'
  },
  {
    path: 'src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge.ts',
    closeBrowserTabMentions: 2,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Host session-tab requests are applied locally without echo.'
  },
  {
    path: 'src/renderer/src/hooks/ipc-events/tab-lifecycle-ipc-bridge.ts',
    closeBrowserTabMentions: 2,
    reasonCarryingCloseCalls: 1,
    planReasonForwardings: 1,
    routesThroughPlan: true,
    why: 'The local menu close routes through the shared ownership plan; host fallback has no owner.'
  },
  {
    path: 'src/renderer/src/runtime/browser-workspace-tab-close.ts',
    closeBrowserTabMentions: 1,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: true,
    why: 'The funnel disavowal fallback completes teardown when every owning host denies the tab.'
  },
  {
    path: 'src/renderer/src/runtime/web-runtime-browser-tab-staging.ts',
    closeBrowserTabMentions: 1,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Rolls back a client-staged row for a create that never reached a host page.'
  },
  {
    path: 'src/renderer/src/store/slices/browser/browser-close-actions.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Slice-owned shutdown tears down every browser row directly.'
  },
  {
    path: 'src/renderer/src/store/slices/browser/browser-slice-contract.ts',
    closeBrowserTabMentions: 1,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'The extracted slice contract declares the close action consumed by browser controllers.'
  }
]

function listSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(dir, entry.name)
    if (entry.isDirectory()) {
      return listSourceFiles(fullPath)
    }
    // Test harnesses and fixtures stub the store action rather than closing anything.
    if (
      !/\.(ts|tsx)$/.test(entry.name) ||
      /\.test\.(ts|tsx)$/.test(entry.name) ||
      /-test-(harness|fixtures)\.(ts|tsx)$/.test(entry.name)
    ) {
      return []
    }
    return [fullPath]
  })
}

// Why: comments are stripped first, so commenting a close call out in place must fail the census
// rather than quietly shrink the count.
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

function countCloseBrowserTabMentions(source: string): number {
  return stripComments(source).match(/\bcloseBrowserTab\b/g)?.length ?? 0
}

describe('browser workspace close census', () => {
  it.each(BROWSER_WORKSPACE_CLOSE_SITES)(
    '$path mentions closeBrowserTab $closeBrowserTabMentions times, plan-routed: $routesThroughPlan',
    ({ path, closeBrowserTabMentions, routesThroughPlan }) => {
      const source = stripComments(readFileSync(join(process.cwd(), path), 'utf8'))
      expect(countCloseBrowserTabMentions(source)).toBe(closeBrowserTabMentions)
      expect(/\bcloseBrowserWorkspaceTabOnHosts\(/.test(source)).toBe(routesThroughPlan)
    }
  )

  it('lists every renderer file that closes a browser workspace', () => {
    const root = join(process.cwd(), 'src/renderer')
    const closers = listSourceFiles(root)
      .filter((filePath) => countCloseBrowserTabMentions(readFileSync(filePath, 'utf8')) > 0)
      .map((filePath) => relative(process.cwd(), filePath).split(sep).join('/'))
      .sort()
    expect(closers).toEqual(BROWSER_WORKSPACE_CLOSE_SITES.map((site) => site.path).sort())
  })

  // Why: the plan is only an authority if its consumers actually run its local teardown. A site
  // that reads the plan and then closes on its own terms is the same divergence with extra steps.
  // Bound to the forwarding expression itself — merely mentioning localCloseReason is not wiring,
  // and Terminal.tsx's two sites have no behavior test to catch it going missing.
  it('every plan-routed site forwards the plan cleanup reason into its local teardown', () => {
    const forwardsReason =
      /plan\.localCloseReason\s*\?\s*\{\s*reason:\s*plan\.localCloseReason\s*\}\s*:\s*undefined/g
    // Why: the expression existing somewhere in the file is not the wiring — a call that drops it on
    // the floor reads identically. Both halves are pinned: the reason is computed, and the close
    // calls carry it.
    const carriesReason =
      /closeBrowserTab\(\s*[^()]*?(?:[Cc]loseOptions|plan\.localCloseReason)[^()]*?\)/g
    for (const site of BROWSER_WORKSPACE_CLOSE_SITES) {
      const source = stripComments(readFileSync(join(process.cwd(), site.path), 'utf8'))
      expect({
        path: site.path,
        forwards: source.match(forwardsReason)?.length ?? 0,
        carrying: source.match(carriesReason)?.length ?? 0
      }).toEqual({
        path: site.path,
        forwards: site.planReasonForwardings,
        carrying: site.reasonCarryingCloseCalls
      })
    }
  })
})
