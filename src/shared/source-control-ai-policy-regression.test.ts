import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { resolveSourceControlAiForOperation } from './source-control-ai'

describe('source-control AI policy regressions', () => {
  it('does not apply a local model choice to an SSH execution host', () => {
    const settings = getDefaultSettings('/repo')
    settings.defaultTuiAgent = 'codex'
    settings.sourceControlAi = {
      ...settings.sourceControlAi!,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4' },
      selectedModelByAgentByHost: { local: { codex: 'gpt-5.4' } }
    }

    const result = resolveSourceControlAiForOperation({
      settings,
      operation: 'commitMessage',
      discoveryHostKey: 'ssh:build-host'
    })

    expect(result).toMatchObject({
      ok: true,
      value: { params: { agentId: 'codex', model: 'gpt-5.5' } }
    })
  })

  it('keeps repo recipe and host model precedence scoped to one operation', () => {
    const settings = getDefaultSettings('/repo')
    settings.defaultTuiAgent = 'codex'
    settings.agentCmdOverrides = { codex: ' managed-codex ' }
    settings.sourceControlAi = {
      ...settings.sourceControlAi!,
      agentId: 'codex',
      selectedModelByAgent: { codex: 'gpt-5.4' },
      instructionsByOperation: {
        ...settings.sourceControlAi!.instructionsByOperation,
        commitMessage: 'global instruction'
      }
    }
    const repo = {
      sourceControlAi: {
        modelOverridesByOperation: {
          commitMessage: {
            selectedModelByAgentByHost: {
              'ssh:build-host': { codex: 'gpt-5.4-mini' }
            },
            selectedThinkingByModel: { 'gpt-5.4-mini': 'xhigh' }
          }
        },
        instructionsByOperation: { commitMessage: ' repo instruction ' },
        actionOverrides: {
          commitMessage: {
            commandInputTemplate: '{basePrompt}\n\nRepo policy',
            agentArgs: ' --json '
          }
        }
      }
    }

    const result = resolveSourceControlAiForOperation({
      settings,
      repo,
      operation: 'commitMessage',
      discoveryHostKey: 'ssh:build-host'
    })

    expect(result).toMatchObject({
      ok: true,
      value: {
        params: {
          agentId: 'codex',
          model: 'gpt-5.4-mini',
          thinkingLevel: 'xhigh',
          customPrompt: 'repo instruction',
          commandInputTemplate: '{basePrompt}\n\nRepo policy',
          agentArgs: '--json',
          agentCommandOverride: 'managed-codex'
        }
      }
    })
  })
})
