import { assertAutomationExtraAgentArgs } from '../../automations/launch/automation-extra-agent-args-record'
import { expect, it } from 'vitest'
import { terminalSessionOptionInputs, resolveAgentLaunchCommand } from './tui-agent-launch-command'
import {
  agentPickerDraft,
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from '../picker/agent-launch-picker'
import { applyAgentPickerEdit } from '../picker/agent-launch-picker-edits'
import { TEXT_ACTION_DEFAULT_MODEL } from '../picker/agent-launch-picker-text-action'
import { automationLaunchInputs } from '../../automations/launch/automation-launch-choices'

it.each([
  ['claude', '--effort high --add-dir docs', "claude '--add-dir' 'docs'"],
  ['claude', '--effort=high --add-dir docs', "claude '--add-dir' 'docs'"],
  ['claude', '--effort low --effort=high --add-dir docs', "claude '--add-dir' 'docs'"],
  ['claude', '--effort high', 'claude'],
  ['claude', '--effort high -- --effort low', "claude '--' '--effort' 'low'"],
  ['codex', '-c model_reasoning_effort="high" --add-dir docs', "codex '--add-dir' 'docs'"],
  ['codex', '--config=model_reasoning_effort="high" --add-dir docs', "codex '--add-dir' 'docs'"],
  ['codex', '--reasoning-effort high --add-dir docs', "codex '--add-dir' 'docs'"],
  ['muse', '--reasoning-effort=high', 'muse'],
  ['pi', '--thinking high', 'pi'],
  ['omp', '--thinking=high', 'omp'],
  ['grok', '--reasoning-effort high', 'grok'],
  ['codebuddy', '--effort high', 'codebuddy'],
  ['antigravity', '--effort=high', 'antigravity']
] as const)('Default composes %s Arguments %s without effort', (agent, raw, expected) => {
  const inputs = terminalSessionOptionInputs({
    agent,
    settings: { agentPermissionDefault: 'own', agentDefaultArgs: { [agent]: raw } },
    agentArgs: undefined,
    sessionOptions: undefined,
    omitEffort: true,
    shell: 'posix'
  })
  const launch = resolveAgentLaunchCommand({
    ...inputs,
    agent,
    cmdOverrides: { [agent]: agent },
    platform: 'linux',
    agentHostPlatform: null,
    shell: 'posix'
  })
  expect(launch.ok && launch.command).toBe(expected)
})

it('Default stays sparse and preserves saved models while unrelated Settings arguments change', () => {
  const entry: AgentPickerEntry = {
    agent: 'claude',
    label: 'Claude',
    rows: [{ kind: 'terminal', agent: 'claude' }],
    surfaces: ['terminal'],
    defaultSurface: 'terminal',
    terminal: { model: 'sonnet', options: { effort: 'high' } },
    structured: {},
    arguments: '--model sonnet --effort high --add-dir docs',
    catalog: { origin: 'unknown' }
  }
  const cleared = applyAgentPickerEdit(entry, agentPickerDraft(entry), {
    kind: 'choice',
    patch: { options: { effort: TEXT_ACTION_DEFAULT_MODEL } }
  })
  const fresh = agentPickerLaunchInputs(cleared, entry)
  expect(fresh).toEqual({ omitEffort: true })
  expect(cleared.acceptedEdits).toEqual({ choices: { options: { effort: null } } })
  const automation = automationLaunchInputs('claude', {
    launchPreferences: { model: 'opus', options: { effort: null } }
  })
  for (const inputs of [fresh, automation]) {
    for (const raw of [
      '--model sonnet --effort high --add-dir docs',
      '--model sonnet --add-dir src'
    ]) {
      const options = terminalSessionOptionInputs({
        ...inputs,
        agent: 'claude',
        shell: 'posix',
        agentArgs: inputs.agentArgs,
        sessionOptions: inputs.sessionOptions,
        settings: {
          agentPermissionDefault: 'own',
          agentDefaultArgs: { claude: raw },
          agentLaunchChoices: { claude: { options: { effort: 'high' } } }
        }
      })
      const launch = resolveAgentLaunchCommand({
        ...options,
        agent: 'claude',
        cmdOverrides: {},
        platform: 'linux',
        shell: 'posix'
      })
      const directory = raw.endsWith('docs') ? 'docs' : 'src'
      expect(launch.ok && launch.command).toBe(
        inputs === automation
          ? directory === 'docs'
            ? "claude '--add-dir' 'docs' '--model' 'opus'"
            : "claude '--add-dir' 'src' '--model' 'opus'"
          : directory === 'docs'
            ? "claude '--model' 'sonnet' '--add-dir' 'docs'"
            : "claude '--model' 'sonnet' '--add-dir' 'src'"
      )
    }
  }
})

it.each(['--debug --effort high', '--effort "high', '--add-dir "unfinished'])(
  'refuses Default rather than silently retaining ambiguous Arguments %s',
  (raw) => {
    expect(() =>
      terminalSessionOptionInputs({
        agent: 'claude',
        shell: 'posix',
        agentArgs: raw,
        sessionOptions: undefined,
        omitEffort: true
      })
    ).toThrow()
  }
)

it('keeps a saved Default automation valid when it reuses its session', () => {
  expect(() =>
    assertAutomationExtraAgentArgs({
      agentId: 'claude',
      reuseSession: true,
      launchPreferences: { options: { effort: null } }
    })
  ).not.toThrow()
})

it('preserves valid host Arguments when another shell cannot parse them', () => {
  const result = terminalSessionOptionInputs({
    agent: 'claude',
    shell: 'posix',
    omitEffort: true,
    agentArgs: "--append-system-prompt don\\'t\\ panic",
    sessionOptions: undefined
  })
  expect(result.agentArgs).toBe("--append-system-prompt don\\'t\\ panic")
  expect(result.sessionOptions?.effort).toBeUndefined()
})
