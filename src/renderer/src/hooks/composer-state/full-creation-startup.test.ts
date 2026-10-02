import { describe, expect, it } from 'vitest'
import { planLaunchPrompt } from '@/lib/tui-agent-startup'
import { composerAgentStartupPlan } from '@/lib/composer-agent-startup-plan'
import { buildFullCreationStartup } from './full-creation-startup'
import { tuiAgentToAgentKind } from '../../../../shared/agent-kind'

describe('the full composer’s renderer-spawned startup', () => {
  // Why: SSH repos, folder repos, repos with default tabs and a failed backend spawn all take this
  // path; without the file the agent is pointed at nothing and the prompt is lost.
  it('carries the launch file its command points at', () => {
    const prompt = 'x'.repeat(200_000)
    const startupPlan = composerAgentStartupPlan(
      planLaunchPrompt({
        agent: 'claude',
        prompt,
        cmdOverrides: {},
        platform: 'linux',
        isRemote: true,
        host: {
          paired: false,
          provesAgentInFront: true,
          takesLaunchFile: true,
          windowsPaneShell: null
        },
        paste: 'when-host-proves-agent'
      }),
      prompt
    )
    const startup = buildFullCreationStartup({
      startupPlan,
      backendSpawnedStartup: false,
      agent: 'claude',
      shouldSeedInitialAgentStatus: false,
      prompt: 'x'.repeat(200_000),
      telemetry: {
        agent_kind: tuiAgentToAgentKind('claude'),
        launch_source: 'new_workspace_composer',
        request_kind: 'new'
      }
    })
    expect(startupPlan?.launchFile).toBeDefined()
    expect(startup?.launchFile).toEqual(startupPlan?.launchFile)
    expect(startup?.command).toContain(startupPlan?.launchFile?.placeholder)
    // Handed back to copy if the host refuses the spawn.
    expect(startup?.launchPrompt).toBe(prompt)
  })
})
