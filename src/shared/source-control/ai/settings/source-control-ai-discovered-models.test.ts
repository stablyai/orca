import { expect, it } from 'vitest'
import { LOCAL_COMMIT_MESSAGE_HOST_KEY } from '../generation/commit-message-host-key'
import { savedDiscoveredModels, withDiscoveredModels } from './source-control-ai-model-selection'
import type { SourceControlAiSettings } from './source-control-ai-settings-types'

it('saves discovered Claude rows without the resolved model an alias row carries', () => {
  const discovered = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5', resolvedModel: 'claude-opus-5-5' },
    { id: 'opus', label: 'Opus alias', resolvedModel: 'claude-opus-5-5' }
  ]
  const saved = withDiscoveredModels(
    {} as SourceControlAiSettings,
    'claude',
    discovered,
    LOCAL_COMMIT_MESSAGE_HOST_KEY
  )
  const rows = [
    { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { id: 'opus', label: 'Opus alias' }
  ]
  expect(saved.discoveredModelsByAgent?.claude).toEqual(rows)
  expect(saved.discoveredModelsByAgentByHost?.[LOCAL_COMMIT_MESSAGE_HOST_KEY]?.claude).toEqual(rows)
  // The refresh compares the same saved shape, so an unchanged listing writes nothing.
  expect(savedDiscoveredModels(discovered)).toEqual(rows)
})
