import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store'
import type { GlobalSettings } from '../../../../../../shared/types'

const saveSourceControlAiSettings = vi.fn()
const toastError = vi.fn()
vi.mock('@/lib/agent-catalog-authoring', () => ({
  saveSourceControlAiSettings: (changes: unknown) => saveSourceControlAiSettings(changes)
}))
vi.mock('sonner', () => ({ toast: { error: (...args: unknown[]) => toastError(...args) } }))

const { saveSourceControlAiActionRecipeForTarget } = await import('./recipe-persistence')

const settings = {
  sourceControlAi: { enabled: true },
  commitMessageAi: { enabled: true }
} as unknown as GlobalSettings

function saveGlobalCommitMessageRecipe(): Promise<void> {
  return saveSourceControlAiActionRecipeForTarget({
    getStoreState: () => ({ settings, repos: [] }) as Pick<AppState, 'settings' | 'repos'>,
    updateRepo: vi.fn() as unknown as AppState['updateRepo'],
    target: { type: 'global' },
    actionId: 'commitMessage',
    recipe: { agentId: 'claude', commandInputTemplate: 'Write a commit message.' }
  })
}

describe('saveSourceControlAiActionRecipeForTarget', () => {
  beforeEach(() => {
    saveSourceControlAiSettings.mockReset()
    toastError.mockClear()
  })

  it('resolves without notifying when the recipe reached disk', async () => {
    saveSourceControlAiSettings.mockResolvedValue({ ok: true })

    await expect(saveGlobalCommitMessageRecipe()).resolves.toBeUndefined()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('reports and rejects when the reference write was not persisted', async () => {
    saveSourceControlAiSettings.mockResolvedValue({
      ok: false,
      code: 'agent_reference_write_failed'
    })

    await expect(saveGlobalCommitMessageRecipe()).rejects.toThrow(/try again/)
    expect(toastError).toHaveBeenCalledTimes(1)
  })
})
