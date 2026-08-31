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
    path: 'src/renderer/src/components/Terminal.tsx',
    closeBrowserTabMentions: 8,
    reasonCarryingCloseCalls: 3,
    planReasonForwardings: 2,
    routesThroughPlan: true,
    why: 'handleCloseBrowserTab (legacy tab bar + Cmd/Ctrl+W) and closeTabBarTabs (bulk close).'
  },
  {
    path: 'src/renderer/src/components/tab-group/useTabGroupTabCloseCommands.ts',
    closeBrowserTabMentions: 4,
    reasonCarryingCloseCalls: 1,
    planReasonForwardings: 1,
    routesThroughPlan: true,
    why: 'closeBrowserItem, shared by the split-pane strip X (closeItem) and bulk close (closeMany).'
  },
  {
    path: 'src/renderer/src/hooks/ipc-events/tab-lifecycle-ipc-bridge.ts',
    closeBrowserTabMentions: 2,
    reasonCarryingCloseCalls: 1,
    planReasonForwardings: 1,
    routesThroughPlan: true,
    why:
      'onCloseActiveTab is the local menu close and routes through the plan. Its other close is ' +
      'the ownerless fallback, which has no worktree for the plan to reason about.'
  },
  {
    path: 'src/renderer/src/hooks/ipc-events/browser-request-ipc-bridge.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why:
      'onRequestTabClose and the bridge-keyed closes answer a close the HOST asked for, so ' +
      'consulting the plan would echo a session.tabs.close back at the requester.'
  },
  {
    path: 'src/renderer/src/hooks/ipc-events/session-tab-ipc-bridge.ts',
    closeBrowserTabMentions: 2,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'onCloseSessionTab and onSessionTabCloseRequest are the host asking; same echo carve-out.'
  },
  {
    path: 'src/renderer/src/components/floating-terminal/FloatingTerminalPanel.tsx',
    closeBrowserTabMentions: 6,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why:
      'The floating workspace is never host-mirrored — applyWebSessionTabsSnapshot returns state ' +
      'unchanged for FLOATING_TERMINAL_WORKTREE_ID — so its browser tabs have no remote owner.'
  },
  {
    path: 'src/renderer/src/components/browser-pane/stream-remote/use-remote-browser-page-lifecycle.ts',
    closeBrowserTabMentions: 4,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why: 'Mirrors a page the host already retired; a plan-driven close would echo it back.'
  },
  {
    path: 'src/renderer/src/runtime/web-runtime-browser-tab-staging.ts',
    closeBrowserTabMentions: 1,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why:
      'Unwinds rows this client minted for a create that never landed — there is no host page. ' +
      'Skipping the funnel also skips its parked-chrome release; the edit-session microtask fence ' +
      'and the deferred-navigation TTL collect those.'
  },
  {
    path: 'src/renderer/src/runtime/browser-workspace-tab-close.ts',
    closeBrowserTabMentions: 1,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: true,
    why:
      'The funnel itself. Its one close is the disavowal fallback: when every owning host answers ' +
      'that it has no such tab, nobody is left to retract the mirror through sync, so the funnel ' +
      'finishes the teardown. No cleanup reason because a disavowed page was never staged.'
  },
  {
    path: 'src/renderer/src/store/slices/browser.ts',
    closeBrowserTabMentions: 3,
    reasonCarryingCloseCalls: 0,
    planReasonForwardings: 0,
    routesThroughPlan: false,
    why:
      'shutdownWorktreeBrowsers tears the whole worktree down; the slice is the seam itself. Same ' +
      'carve-out for parked chrome as the staging rollback, and page ids are unique so a later ' +
      "page cannot pick up a dead one's entry."
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
