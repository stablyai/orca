import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getDefaultSettings } from '../../../../shared/constants'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { TuiAgent } from '../../../../shared/tui-agent'
import { resolveTuiAgentLaunchArgs } from '../../../../shared/tui-agent-launch-defaults'

const DARWIN = { platform: 'darwin' } as const

const storeState = vi.hoisted(() => {
  const state: { settings: GlobalSettings | null } = { settings: null }
  return state
})

vi.mock('@/store', () => ({ useAppStore: { getState: () => storeState } }))
vi.mock('@/lib/new-workspace', () => ({ CLIENT_PLATFORM: 'darwin' }))

const CALLER_ARGS = '--model gpt-5.5'

async function preview(agent: TuiAgent): Promise<string> {
  const { buildSourceControlAgentDeliveryPlan } =
    await import('./buildSourceControlAgentDeliveryPlan')
  const plan = buildSourceControlAgentDeliveryPlan({
    selectedAgent: agent,
    commandInput: 'Write the commit message.',
    agentArgs: CALLER_ARGS,
    promptDelivery: 'submit-after-ready',
    detectedAgents: [agent],
    connectionUnavailable: false,
    launchPlatform: 'darwin'
  })
  expect(plan.status).toBe('success')
  return plan.status === 'success' ? (plan.commandLabel ?? '') : ''
}

// The dialog preview shows the launch the action will start: each agent's effective mode under Yolo.
describe('buildSourceControlAgentDeliveryPlan permission preview', () => {
  beforeEach(() => {
    storeState.settings = null
  })

  it.each([
    ['codex', '-a on-request', '--dangerously-bypass-approvals-and-sandbox', false],
    ['claude', '--permission-mode acceptEdits', '--dangerously-skip-permissions', false],
    ['gemini', '-y', '--yolo', true]
  ] as const)(
    'previews %s configured %j with the flag only if it launches in bypass',
    async (agent, configured, flag, flagged) => {
      const settings: GlobalSettings = {
        ...getDefaultSettings('/tmp'),
        agentPermissionMode: 'bypass',
        agentDefaultArgs: { [agent]: configured }
      }
      storeState.settings = settings

      const label = await preview(agent)

      expect(label.includes(flag)).toBe(flagged)
      expect(label).toContain('gpt-5.5')
      expect(resolveTuiAgentLaunchArgs(agent, settings, DARWIN, CALLER_ARGS).includes(flag)).toBe(
        flagged
      )
    }
  )
})
