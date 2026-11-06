import { describe, expect, it, vi } from 'vitest'
import { saveSourceControlTextGenerationDefaults } from './recipe-persistence'
import {
  ON_DEVICE_TEXT_GENERATION_ID,
  ON_DEVICE_TEXT_GENERATION_MODEL_ID
} from '../../../../../../shared/on-device-text-generation'

describe('saving per-action defaults with the on-device provider', () => {
  it('refuses instead of pinning a null agent that overrides the provider', async () => {
    const save = vi.fn(async () => {})

    await expect(
      saveSourceControlTextGenerationDefaults({
        saveActionRecipeForTarget: save,
        target: { type: 'global' },
        actionId: 'commitMessage',
        params: {
          agentId: ON_DEVICE_TEXT_GENERATION_ID,
          model: ON_DEVICE_TEXT_GENERATION_MODEL_ID,
          commandInputTemplate: '{basePrompt}'
        }
      })
    ).rejects.toThrow(/per-action defaults/i)
    expect(save).not.toHaveBeenCalled()
  })
})
