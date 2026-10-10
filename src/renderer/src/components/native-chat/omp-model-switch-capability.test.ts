import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearNativeChatSessionOptionCacheForTests } from './native-chat-session-option-cache'
import { createNativeChatPtySessionOptions } from './native-chat-pty-session-options'
import {
  normalizeAgentStatusPayload,
  pickParsedAgentStatusPayload
} from '../../../../shared/agent-status-types'

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

  it('preserves only the recognized capability through normalization and remote projection', () => {
    for (const command of ['orca-model', 'arbitrary-command', undefined]) {
      const payload = normalizeAgentStatusPayload({
        state: 'done',
        agentType: 'omp',
        modelSwitchCommand: command
      })
      if (!payload) {
        throw new Error('expected status')
      }
      expect(pickParsedAgentStatusPayload(payload).modelSwitchCommand).toBe(
        command === 'orca-model' ? command : undefined
      )
    }
  })
})
