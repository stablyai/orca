import { expect, it } from 'vitest'
import {
  antigravityTerminalChoicePatch,
  groupAntigravityModelEfforts
} from '../../agent-session/options/antigravity-model-efforts'
import { buildAgentStartupPlan } from './tui-agent-startup'
import { resolveAgentStartupPlanInputs } from './agent-startup-plan-inputs'

it('normalizes the final Antigravity launch after defaults and raw argument ownership', () => {
  const models = [
    { id: 'gemini-3.8-flash-low', label: 'Gemini 3.8 Flash (Low)' },
    { id: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)' },
    { id: 'gpt-oss-120b-medium', label: 'GPT-OSS 120B (Medium)' },
    { id: 'gemini-3.5-flash-low', label: 'Gemini 3.5 Flash (Low)' },
    { id: 'gemini-3.5-flash', label: 'Gemini 3.5 Flash (High)' },
    { id: 'duplicate', label: 'Duplicate (High)' },
    { id: 'duplicate-low', label: 'Duplicate (Low)' },
    { id: 'duplicate-high', label: 'Duplicate (High)' }
  ]
  const launch = (
    options: { model?: string; effort?: string },
    extra: {
      agentArgs?: string
      command?: string
      cold?: boolean
      inherited?: boolean
      defaultArgs?: string
    } = {}
  ) =>
    buildAgentStartupPlan({
      ...resolveAgentStartupPlanInputs({
        agent: 'antigravity',
        settings: {
          agentPermissionDefault: 'own',
          agentCmdOverrides: { antigravity: extra.command ?? 'agy' },
          ...(extra.defaultArgs ? { agentDefaultArgs: { antigravity: extra.defaultArgs } } : {}),
          ...(extra.inherited ? { agentLaunchChoices: { antigravity: { options } } } : {})
        },
        platform: 'linux',
        shell: 'posix',
        isRemote: false,
        agentArgs: extra.agentArgs,
        sessionOptions: extra.inherited ? undefined : options
      }),
      antigravityModels: extra.cold ? undefined : models,
      prompt: 'Reply OK'
    })
  for (const [options, expected] of [
    [
      { model: 'gemini-3.8-flash', effort: 'low' },
      "agy '--model' 'gemini-3.8-flash-low' --prompt-interactive 'Reply OK'"
    ],
    [
      { model: 'gemini-3.8-flash-high', effort: 'low' },
      "agy '--model' 'gemini-3.8-flash-low' --prompt-interactive 'Reply OK'"
    ],
    [
      { model: 'gemini-3.8-flash-high', effort: 'high' },
      "agy '--model' 'gemini-3.8-flash-high' --prompt-interactive 'Reply OK'"
    ],
    [
      { model: 'gemini-3.8-flash', effort: 'medium' },
      "agy '--model' 'gemini-3.8-flash-low' --prompt-interactive 'Reply OK'"
    ],
    [
      { model: 'gpt-oss-120b-medium', effort: 'low' },
      "agy '--model' 'gpt-oss-120b-medium' --prompt-interactive 'Reply OK'"
    ],
    [
      { model: 'gemini-3.5-flash-low', effort: 'high' },
      "agy '--model' 'gemini-3.5-flash' --prompt-interactive 'Reply OK'"
    ],
    [
      { model: 'duplicate', effort: 'high' },
      "agy '--model' 'duplicate-high' --prompt-interactive 'Reply OK'"
    ],
    [{ model: 'private-model' }, "agy '--model' 'private-model' --prompt-interactive 'Reply OK'"]
  ] as const) {
    expect(launch(options)).toMatchObject({ launchCommand: expected })
    expect(launch(options)?.warning).toBeUndefined()
  }
  expect(
    launch({ model: 'claude-sonnet-5-5-medium', effort: 'low' }, { cold: true })
  ).toMatchObject({
    launchCommand: "agy '--model' 'claude-sonnet-5-5-low' --prompt-interactive 'Reply OK'",
    warning: 'Antigravity: model list unavailable; trying the requested effort.'
  })
  expect(launch({ model: 'private-model', effort: 'unknown' })).toMatchObject({
    launchCommand: "agy '--model' 'private-model' --prompt-interactive 'Reply OK'",
    warning: "Antigravity: couldn't match the effort; starting the selected model."
  })
  expect(launch({ model: 'gemini-3.8-flash-high' }, { command: 'agy --effort low' })).toMatchObject(
    {
      launchCommand:
        "agy --effort low '--model' 'gemini-3.8-flash-low' --prompt-interactive 'Reply OK'"
    }
  )
  expect(
    launch({}, { agentArgs: '--model gemini-3.8-flash-high --effort low --add-dir docs' })
  ).toMatchObject({
    launchCommand:
      "agy '--model' 'gemini-3.8-flash-low' '--add-dir' 'docs' --prompt-interactive 'Reply OK'"
  })
  expect(launch({ effort: 'high' })).toMatchObject({
    launchCommand: "agy --prompt-interactive 'Reply OK'",
    warning: 'Antigravity: no model selected; starting its default without the requested effort.'
  })
  expect(launch({ effort: 'low' }, { inherited: true })?.warning).toBeUndefined()
  expect(launch({}, { defaultArgs: '--effort low' })).toMatchObject({
    launchCommand: "agy --prompt-interactive 'Reply OK'"
  })
  expect(launch({}, { defaultArgs: '--effort low' })?.warning).toBeUndefined()
  expect(launch({}, { agentArgs: '--effort low' })).toMatchObject({
    launchCommand: "agy --prompt-interactive 'Reply OK'",
    warning: 'Antigravity: no model selected; starting its default without the requested effort.'
  })
  expect(
    launch(
      { model: 'gemini-3.8-flash-high' },
      {
        agentArgs: '--future-option x --effort low'
      }
    )
  ).toMatchObject({
    launchCommand:
      "agy '--model' 'gemini-3.8-flash-high' '--future-option' 'x' '--effort' 'low' --prompt-interactive 'Reply OK'",
    warning: "Antigravity: couldn't adjust model and effort in Arguments; using them unchanged."
  })
  expect(launch({ effort: 'low' }, { command: 'agy --model gemini-3.8-flash-high' })).toMatchObject(
    {
      launchCommand: "agy --model gemini-3.8-flash-high --prompt-interactive 'Reply OK'",
      warning: "Antigravity: couldn't adjust model and effort in Arguments; using them unchanged."
    }
  )
  const cleared = antigravityTerminalChoicePatch(
    groupAntigravityModelEfforts(models),
    { model: 'gemini-3.8-flash-low', options: { effort: 'low' } },
    { options: { effort: null } }
  )
  expect(launch({ model: cleared.model ?? undefined })).toMatchObject({
    launchCommand: "agy '--model' 'gemini-3.8-flash' --prompt-interactive 'Reply OK'"
  })
  expect(
    launch({}, { agentArgs: '--future-option opaque --model private-model --effort low' })
  ).toMatchObject({
    warning: "Antigravity: couldn't adjust model and effort in Arguments; using them unchanged."
  })
})
