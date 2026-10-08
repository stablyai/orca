import { expect, it, vi } from 'vitest'
import { callRuntimeRpc } from '@/runtime/runtime-rpc-client'
import { enqueueSessionOptionSettingsWrite } from './native-chat-session-option-settings-write'

vi.mock('@/runtime/runtime-rpc-client', () => ({ callRuntimeRpc: vi.fn(async () => undefined) }))

it('remembers SSH model picks in the client settings store', async () => {
  const mutation = {
    type: 'apply-picks' as const,
    agent: 'claude' as const,
    picks: [{ modelId: 'sonnet', optionId: 'model', value: 'sonnet' }]
  }
  await enqueueSessionOptionSettingsWrite(
    { kind: 'environment', environmentId: 'ssh-host' },
    mutation
  )
  expect(callRuntimeRpc).toHaveBeenCalledExactlyOnceWith(
    { kind: 'local' },
    'settings.mutateNativeChatSessionOptions',
    mutation
  )
})
