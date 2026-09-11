import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import {
  hasSavedPiSourceControlModel,
  resetPiSourceControlModelsForHost
} from './pi-source-control-model-reset'
import {
  resolveSourceControlAiForOperation,
  projectSourceControlAiToLegacyCommitMessageAi,
  mergeLegacyCommitMessageAiIntoSourceControlAi
} from './source-control-ai'

const copilot = 'github-copilot/gpt-5.4-mini'
describe('Pi model reset', () => {
  it.each(['local', 'ssh:fixture', 'wsl:Ubuntu', 'runtime:fixture'])(
    'resets only Pi choices for %s through save/reload',
    (hostKey) => {
      const settings = getDefaultSettings('/tmp')
      const config = settings.sourceControlAi!
      config.agentId = 'pi'
      config.selectedModelByAgent = { pi: copilot, codex: 'gpt-5.5' }
      config.selectedModelByAgentByHost = {
        [hostKey]: { pi: copilot, codex: 'gpt-5.5' },
        'ssh:other': { pi: 'other/model' }
      }
      config.modelOverridesByOperation = {
        branchName: {
          selectedModelByAgentByHost: {
            [hostKey]: { pi: copilot },
            'ssh:other': { pi: 'other/branch' }
          }
        }
      }
      config.modelOverridesByOperation.branchName!.selectedThinkingByModel = { 'gpt-5.5': 'high' }
      config.actions = { branchName: { agentId: 'pi', agentArgs: '--thinking low' } }
      expect(hasSavedPiSourceControlModel(config, hostKey)).toBe(true)
      const reset = resetPiSourceControlModelsForHost(config, hostKey)
      expect(hasSavedPiSourceControlModel(reset, hostKey)).toBe(false)
      expect(reset.actions).toEqual(config.actions)
      expect(reset.modelOverridesByOperation?.branchName?.selectedThinkingByModel).toEqual({
        'gpt-5.5': 'high'
      })
      expect(reset.selectedModelByAgentByHost?.['ssh:other']).toEqual({ pi: 'other/model' })
      expect(reset.selectedModelByAgentByHost?.[hostKey]?.codex).toBe('gpt-5.5')
      expect(
        reset.modelOverridesByOperation?.branchName?.selectedModelByAgentByHost?.['ssh:other']
      ).toEqual({ pi: 'other/branch' })
      expect(config.selectedModelByAgentByHost?.[hostKey]?.pi).toBe(copilot)
      if (hostKey !== 'local') {
        expect(reset.selectedModelByAgent.pi).toBe(copilot)
      }
      settings.commitMessageAi = projectSourceControlAiToLegacyCommitMessageAi(reset)
      settings.sourceControlAi = mergeLegacyCommitMessageAiIntoSourceControlAi(
        reset,
        settings.commitMessageAi
      )
      for (const operation of ['commitMessage', 'pullRequest', 'branchName'] as const) {
        const resolved = resolveSourceControlAiForOperation({
          settings,
          operation,
          discoveryHostKey: hostKey
        })
        expect(resolved.ok && resolved.value.params.useConfiguredDefaultModel).toBe(true)
      }
    }
  )
  it('does not reset an unresolved host', () => {
    const config = getDefaultSettings('/tmp').sourceControlAi!
    config.selectedModelByAgent.pi = copilot
    expect(hasSavedPiSourceControlModel(config, 'unknown')).toBe(false)
    expect(resetPiSourceControlModelsForHost(config, 'unknown')).toBe(config)
  })
})
