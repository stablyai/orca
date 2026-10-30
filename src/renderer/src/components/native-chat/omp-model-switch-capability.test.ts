import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from '../../../../shared/native-chat-pty-session-options'

describe('OMP model command capability', () => {
  beforeEach(() => clearNativeChatSessionOptionCacheForTests())

  it.each([undefined, false, true])(
    'only enables a live command after host advertisement: %s',
    async (canSwitchOmpModel) => {
      const dispatchCommand = vi.fn()
      const surface = createNativeChatPtySessionOptions({
        agent: 'omp',
        scopeKey: 'omp-model-test',
        mode: 'live',
        modelLabel: 'Model',
        canSwitchOmpModel,
        initialModels: [
          { id: 'openai/a', label: 'A', options: [] },
          { id: 'openai/b', label: 'B', options: [] }
        ],
        reportedValues: { model: 'openai/a' },
        dispatchCommand
      })
      if (!surface) {
        throw new Error('expected OMP surface')
      }
      expect(surface.getSnapshot()[0].settable).toBe(canSwitchOmpModel === true)
      if (canSwitchOmpModel) {
        await surface.setOption('model', 'openai/b')
        expect(dispatchCommand).toHaveBeenCalledWith('/orca-model openai/b')
      } else {
        await expect(surface.setOption('model', 'openai/b')).rejects.toThrow()
        expect(dispatchCommand).not.toHaveBeenCalled()
      }
    }
  )
})
