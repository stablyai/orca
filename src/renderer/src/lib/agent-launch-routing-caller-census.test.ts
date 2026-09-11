import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { glob } from 'tinyglobby'

const REPO_ROOT = join(import.meta.dirname, '../../../..')
const CENSUS_FILE = 'src/renderer/src/lib/agent-launch-routing-caller-census.test.ts'

const LAUNCH_AGENT_IN_NEW_TAB_CALLERS = [
  'src/renderer/src/components/dashboard/launch-dashboard-agent.ts',
  'src/renderer/src/components/right-sidebar/runSourceControlAgentActionStart.ts',
  'src/renderer/src/components/right-sidebar/source-control/ai/recovery-launch.ts',
  'src/renderer/src/components/right-sidebar/source-control/sync/use-git-history-commit-actions.ts',
  'src/renderer/src/components/tab-bar/QuickLaunchButton.tsx',
  'src/renderer/src/components/tab-bar/use-tab-bar-create-menu-controller.ts',
  'src/renderer/src/components/terminal-pane/terminal-agent-session-fork.ts',
  'src/renderer/src/components/use-terminal-create-actions.ts',
  'src/renderer/src/lib/fix-checks-agent-launch.ts',
  'src/renderer/src/lib/launch-agent-session-continuation.ts',
  'src/renderer/src/lib/run-quick-command-in-new-tab.ts'
]

// Why: the planner is the one production module that decides a route. A second resolver call
// site is how the seven launch sites drifted apart before it existed.
const ROUTE_RESOLVER_DEFINITION = 'src/renderer/src/lib/agent-launch-routing.ts'
const ROUTE_PLANNER = 'src/renderer/src/lib/agent-session-launch-plan.ts'
const DIRECT_ROUTE_RESOLVER_CALL = /\b(?:resolveAgentLaunchRoute|structuredAgentLaunchSupported)\(/
// Why: adopting a verdict bypasses the resolver by design (a persisted quick-create request, a
// resume whose gate already planned), so each adopter is pinned rather than trusted by convention.
const VERDICT_ADOPTERS = [
  // Launch sites now route through launchAgentSession; no production caller adopts a verdict.
]

async function productionFiles(): Promise<string[]> {
  return glob(['src/**/*.ts', 'src/**/*.tsx'], {
    cwd: REPO_ROOT,
    ignore: ['**/*.test.ts', '**/*.test.tsx', CENSUS_FILE]
  })
}

describe('agent launch routing caller census', () => {
  it('pins every production launchAgentInNewTab caller behind the shared funnel', async () => {
    const callers = (await productionFiles())
      .filter((file) => file !== 'src/renderer/src/lib/launch-agent-in-new-tab.ts')
      .filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('launchAgentInNewTab(')
      )
      .sort()
    expect(callers).toEqual([...LAUNCH_AGENT_IN_NEW_TAB_CALLERS].sort())
  })

  it('lets only the planner decide a launch route', async () => {
    const directCallers = (await productionFiles())
      .filter((file) => file !== ROUTE_RESOLVER_DEFINITION)
      .filter((file) =>
        DIRECT_ROUTE_RESOLVER_CALL.test(readFileSync(join(REPO_ROOT, file), 'utf8'))
      )
      .sort()
    expect(directCallers).toEqual([ROUTE_PLANNER])
  })

  it('pins every production adopter of a planned verdict', async () => {
    const adopters = (await productionFiles())
      .filter((file) => file !== ROUTE_PLANNER)
      .filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('adoptAgentSessionLaunchVerdict(')
      )
      .sort()
    expect(adopters).toEqual([...VERDICT_ADOPTERS].sort())
  })

  it('keeps non-visible, resume, and floating launchers intentionally outside the route', () => {
    for (const file of [
      'src/renderer/src/lib/launch-agent-background-session.ts',
      'src/renderer/src/lib/launch-ai-vault-session.ts',
      'src/renderer/src/components/floating-terminal/FloatingTerminalWindowControls.tsx'
    ]) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8')).not.toContain('resolveAgentLaunchRoute')
    }
  })
})
