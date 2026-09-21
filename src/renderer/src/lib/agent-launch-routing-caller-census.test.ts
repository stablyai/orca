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

const ROUTE_POLICY_OWNERS = [
  'src/renderer/src/components/sidebar/folder-workspace-composer-submit.ts',
  'src/renderer/src/hooks/composer-state/full-creation-execution.ts',
  'src/renderer/src/hooks/composer-state/quick-creation-execution.ts',
  'src/renderer/src/lib/launch-agent-in-new-tab.ts',
  'src/renderer/src/lib/launch-work-item-direct.ts',
  'src/renderer/src/lib/onboarding-folder-agent-startup.ts'
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

  it('pins the direct creation families that must own one route decision', async () => {
    const owners = (await productionFiles())
      .filter((file) => file !== 'src/renderer/src/lib/agent-launch-routing.ts')
      .filter((file) =>
        readFileSync(join(REPO_ROOT, file), 'utf8').includes('resolveAgentLaunchRoute(')
      )
      .sort()
    expect(owners).toEqual([...ROUTE_POLICY_OWNERS].sort())
  })

  it('keeps non-visible, resume, and floating launchers intentionally outside the route', () => {
    for (const file of [
      'src/renderer/src/lib/launch-agent-background-session.ts',
      'src/renderer/src/lib/launch-ai-vault-session.ts',
      'src/renderer/src/components/floating-terminal/FloatingTerminalWindowControls.tsx'
    ]) {
      expect(readFileSync(join(REPO_ROOT, file), 'utf8')).not.toContain('resolveAgentLaunchRoute(')
    }
  })
})
