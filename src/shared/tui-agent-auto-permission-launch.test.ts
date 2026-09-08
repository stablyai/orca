import { describe, expect, it } from 'vitest'
import { applyAgentPermissionMode, AUTO_TUI_AGENT_ARGS } from './tui-agent-permissions'
import {
  resolveAgentLaunchPermissionModeSummary,
  normalizeTuiAgentArgsRecord,
  normalizeTuiAgentEnvRecord,
  resolveTuiAgentLaunchArgs,
  resolveTuiAgentLaunchEnv
} from './tui-agent-launch-defaults'
import { buildAgentStartupPlan } from './tui-agent-startup'
import type { TuiAgent } from './tui-agent'
import { tokenizeStartupCommand } from './tui-agent-startup-shell'

describe('Auto permission launch settings', () => {
  it.each(['darwin', 'linux', 'win32'] as const)(
    'retains guarded presets through normalization and local/remote %s launch planning',
    (platform) => {
      const profile = applyAgentPermissionMode({ mode: 'auto' })
      const args = normalizeTuiAgentArgsRecord(profile.agentDefaultArgs)
      const env = normalizeTuiAgentEnvRecord(profile.agentDefaultEnv)
      for (const isRemote of [false, true]) {
        for (const agent of [...Object.keys(AUTO_TUI_AGENT_ARGS), 'goose', 'amp'] as TuiAgent[]) {
          const agentArgs = resolveTuiAgentLaunchArgs(agent, args)
          const agentEnv = resolveTuiAgentLaunchEnv(agent, env)
          const plan = buildAgentStartupPlan({
            agent,
            agentArgs,
            agentEnv,
            platform,
            isRemote,
            cmdOverrides: {},
            prompt: '',
            allowEmptyPromptLaunch: true
          })
          expect(plan).not.toBeNull()
          if (agent in AUTO_TUI_AGENT_ARGS) {
            const parsed = tokenizeStartupCommand(
              plan?.launchCommand ?? '',
              platform === 'win32' ? 'powershell' : 'posix'
            )
            expect(parsed.ok).toBe(true)
            if (parsed.ok) {
              const flags = AUTO_TUI_AGENT_ARGS[agent]?.split(' ') ?? []
              expect(parsed.tokens.slice(-flags.length)).toEqual(flags)
            }
          }
          if (agent === 'goose') {
            expect(plan?.env).toEqual({ GOOSE_MODE: 'smart_approve' })
          }
          if (agent === 'amp') {
            expect(agentArgs).toBe('')
            expect(plan?.launchCommand).not.toContain('--dangerously-allow-all')
          }
        }
      }
    }
  )
})

it('classifies effective defaults while preserving explicit Manual and Auto overrides', () => {
  expect(resolveAgentLaunchPermissionModeSummary({})).toBe('yolo')
  expect(
    resolveAgentLaunchPermissionModeSummary({ agentDefaultArgs: {}, agentDefaultEnv: {} })
  ).toBe('yolo')
  expect(
    resolveAgentLaunchPermissionModeSummary(applyAgentPermissionMode({ mode: 'manual' }))
  ).toBe('manual')
  expect(resolveAgentLaunchPermissionModeSummary(applyAgentPermissionMode({ mode: 'auto' }))).toBe(
    'auto'
  )
  expect(resolveAgentLaunchPermissionModeSummary({ agentDefaultArgs: { claude: '' } })).toBe(
    'mixed'
  )
})
