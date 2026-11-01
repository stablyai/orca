import { expect, it, vi } from 'vitest'
import type { GeneratedAgentInputNotice } from '../../../shared/generated-agent-input-notice'
import { applyGeneratedInputNotices } from './generated-agent-input-notices'
import { showGeneratedInputNotice } from '@/lib/launch-agent-paste-timeout-notice'
import { callRuntimeRpc } from './runtime-rpc-client'
import { toast } from 'sonner'

vi.mock('sonner', () => ({ toast: { dismiss: vi.fn() } }))
vi.mock('@/lib/launch-agent-paste-timeout-notice', () => ({ showGeneratedInputNotice: vi.fn() }))
vi.mock('./runtime-rpc-client', () => ({
  callRuntimeRpc: vi.fn(async () => ({ dismissed: true }))
}))

it('deduplicates reconnect snapshots, applies another viewer dismissal and retries failed dismissals', async () => {
  const target = { kind: 'environment', environmentId: 'test-notices' } as const
  const notice: GeneratedAgentInputNotice = {
    id: 'id',
    agent: 'claude',
    text: 'exact\ntext',
    handle: 'pane',
    worktreeId: 'tree',
    ptyId: null,
    certainty: 'unconfirmed'
  }
  applyGeneratedInputNotices(target, [notice])
  applyGeneratedInputNotices(target, [notice])
  expect(showGeneratedInputNotice).toHaveBeenCalledOnce()
  expect(showGeneratedInputNotice).toHaveBeenCalledWith(
    expect.objectContaining({ text: notice.text, certainty: 'unconfirmed' })
  )
  vi.mocked(callRuntimeRpc).mockRejectedValueOnce(new Error('disconnected'))
  const onDismiss = vi.mocked(showGeneratedInputNotice).mock.calls[0][0].onDismiss!
  onDismiss()
  await Promise.resolve()
  await Promise.resolve()
  expect(showGeneratedInputNotice).toHaveBeenCalledTimes(2)
  expect(callRuntimeRpc).toHaveBeenCalledWith(target, 'terminal.dismissGeneratedInputNotice', {
    id: 'id'
  })
  applyGeneratedInputNotices(target, [])
  expect(toast.dismiss).toHaveBeenCalledWith('generated-input:test-notices:id')
  applyGeneratedInputNotices(target, [])
  expect(toast.dismiss).toHaveBeenCalledTimes(1)
})
