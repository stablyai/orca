import { describe, expect, it } from 'vitest'
import { resolveSourceControlAiForOperation } from './source-control-ai-operation-resolution'
import { getDefaultSourceControlAiSettings } from './settings/source-control-ai-settings'

function resolveBranchNameParams(codexModel?: string) {
  const resolved = resolveSourceControlAiForOperation({
    settings: {
      sourceControlAi: {
        ...getDefaultSourceControlAiSettings(),
        agentId: 'codex',
        selectedModelByAgent: codexModel ? { codex: codexModel } : {}
      }
    },
    operation: 'branchName'
  })
  return resolved.ok ? resolved.value.params : null
}

describe('resolveSourceControlAiForOperation default model', () => {
  it('marks the built-in default when no model is picked', () => {
    expect(resolveBranchNameParams()).toMatchObject({
      model: 'gpt-5.6-terra',
      usesOrcaDefaultModel: true
    })
  })

  it('marks the built-in default when the picked model is gone', () => {
    expect(resolveBranchNameParams('retired-model')).toMatchObject({
      model: 'gpt-5.6-terra',
      usesOrcaDefaultModel: true
    })
  })

  it('leaves a picked model unmarked, even the default one', () => {
    const params = resolveBranchNameParams('gpt-5.6-terra')
    expect(params?.model).toBe('gpt-5.6-terra')
    expect(params).not.toHaveProperty('usesOrcaDefaultModel')
  })
})
