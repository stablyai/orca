import { describe, expect, it } from 'vitest'
import { getDefaultSettings } from './constants'
import { getCommitMessageAgentSpec } from './commit-message-agent-spec'
import {
  resolveSourceControlAiForOperation,
  normalizeSourceControlAiSettings
} from './source-control-ai'

for (const hostKey of ['local', 'ssh:omp-host']) {
  describe(`OMP discovery preserves generation choices on ${hostKey}`, () => {
    it.each([undefined, 'default', 'provider/exact-model'])(
      'retains selected model %s when a discovered catalog is cached',
      (selectedModel) => {
        const spec = getCommitMessageAgentSpec('omp')
        if (!spec) {
          throw new Error('Missing OMP spec')
        }
        const models =
          spec.modelDiscovery?.parse(
            JSON.stringify({
              models: [
                {
                  provider: 'provider',
                  id: 'other-model',
                  selector: 'provider/other-model',
                  name: 'Other model'
                },
                {
                  provider: 'provider',
                  id: 'exact-model',
                  selector: 'provider/exact-model',
                  name: 'Exact model'
                }
              ]
            })
          ) ?? []
        expect(models.map((model) => model.id)).toEqual([
          'provider/other-model',
          'provider/exact-model'
        ])
        const settings = getDefaultSettings('/disposable-omp-home')
        settings.defaultTuiAgent = 'omp'
        const config = normalizeSourceControlAiSettings(
          settings.sourceControlAi,
          settings.commitMessageAi
        )
        config.selectedModelByAgentByHost = selectedModel
          ? { [hostKey]: { omp: selectedModel } }
          : {}
        settings.sourceControlAi = {
          ...config,
          discoveredModelsByAgentByHost: { [hostKey]: { omp: models } }
        }
        for (const operation of ['commitMessage', 'pullRequest', 'branchName'] as const) {
          const resolved = resolveSourceControlAiForOperation({
            settings,
            operation,
            discoveryHostKey: hostKey
          })
          expect(resolved.ok).toBe(true)
          if (!resolved.ok) {
            throw new Error(resolved.error)
          }
          expect(resolved.value.params.model).toBe(selectedModel ?? 'default')
          const args = spec.buildArgs({ prompt: '', model: resolved.value.params.model })
          if (selectedModel === 'provider/exact-model') {
            expect(args.slice(-2)).toEqual(['--model', 'provider/exact-model'])
          } else {
            expect(args).not.toContain('--model')
          }
        }
      }
    )
  })
}
