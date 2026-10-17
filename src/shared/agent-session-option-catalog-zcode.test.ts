import { describe, expect, it } from 'vitest'
import { checkAgentLaunchModelPreferences } from './agent-launch-model-preferences'
import { getAgentSessionOptionCatalog } from './agent-session-option-catalog'
import { ZCODE_SESSION_OPTION_CATALOG } from './agent-session-option-catalog-zcode'
import { resolveAgentSessionOptionLaunch } from './agent-session-option-launch'
import { parseBuiltSessionOptionCommand } from './native-chat-session-option-commands'
import { buildAgentStartupPlan } from './tui-agent-startup'

const ZAI_GLM = 'account:zai-individual-coding-plan/GLM-5.3'
const BIGMODEL_FLASH = 'account:bigmodel-individual-coding-plan/GLM-5.3-Flash'

describe('zcode GLM session option catalog', () => {
  it('is registered for the zcode agent', () => {
    expect(getAgentSessionOptionCatalog('zcode')).toBe(ZCODE_SESSION_OPTION_CATALOG)
  })

  it('seeds only the verified GLM ids on both coding-plan providers', () => {
    expect(
      ZCODE_SESSION_OPTION_CATALOG.models.map(({ id, label, description, isDefault }) => ({
        id,
        label,
        description,
        isDefault
      }))
    ).toEqual([
      {
        id: ZAI_GLM,
        label: 'GLM-5.3',
        description: 'Z.AI Coding Plan',
        isDefault: undefined
      },
      {
        id: 'account:zai-individual-coding-plan/GLM-5.3-Flash',
        label: 'GLM-5.3 Flash',
        description: 'Z.AI Coding Plan',
        isDefault: undefined
      },
      {
        id: 'account:bigmodel-individual-coding-plan/GLM-5.3',
        label: 'GLM-5.3',
        description: 'BigModel Coding Plan',
        isDefault: undefined
      },
      {
        id: BIGMODEL_FLASH,
        label: 'GLM-5.3 Flash',
        description: 'BigModel Coding Plan',
        isDefault: undefined
      }
    ])
  })

  it('types a provider/model slash command and nothing else', () => {
    const build = ZCODE_SESSION_OPTION_CATALOG.modelApply.midSession
    expect(build?.kind).toBe('command')
    if (build?.kind !== 'command') {
      return
    }
    expect(build.pickerCommand).toBe('/model')
    for (const model of ZCODE_SESSION_OPTION_CATALOG.models) {
      const command = build.build(model.id)
      expect(command).toBe(`/model ${model.id}`)
      expect(command).not.toContain('--model')
      expect(/\s/.test(model.id)).toBe(false)
      expect(parseBuiltSessionOptionCommand(build.build, command)).toBe(model.id)
    }
  })

  it('refuses launch-time --model instead of emitting a flag ZCode drops', () => {
    expect(ZCODE_SESSION_OPTION_CATALOG.modelApply.launchArgs).toBeUndefined()
    expect(ZCODE_SESSION_OPTION_CATALOG.supportsWorkerLaunchPreferences).toBeUndefined()
    expect(resolveAgentSessionOptionLaunch('zcode', { model: ZAI_GLM })).toEqual({
      args: [],
      appliedValues: {}
    })
    expect(
      checkAgentLaunchModelPreferences({ agent: 'zcode', model: BIGMODEL_FLASH })
    ).toMatchObject({
      refusal: {
        code: 'invalid_argument',
        message: expect.stringContaining('does not support launch-time model selection')
      }
    })
    const plan = buildAgentStartupPlan({
      agent: 'zcode',
      prompt: '',
      cmdOverrides: {},
      platform: 'linux',
      allowEmptyPromptLaunch: true,
      sessionOptions: { model: ZAI_GLM }
    })
    expect(plan?.launchCommand).toBe('zcode')
    expect(plan?.launchCommand).not.toContain('GLM')
    expect(plan?.launchCommand).not.toContain('--model')
  })
})
