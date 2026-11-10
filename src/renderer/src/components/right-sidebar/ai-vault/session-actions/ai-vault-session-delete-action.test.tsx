// @vitest-environment happy-dom

import { cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { toast } from 'sonner'
import type { AiVaultSession } from '../../../../../../shared/ai-vault/contracts/ai-vault-types'
import type { AiVaultDeleteSessionResult } from '../../../../../../shared/ai-vault/contracts/ai-vault-session-deletion'
import { useAiVaultSessionDeleteAction } from './ai-vault-session-delete-action'

const { confirm, deleteSession } = vi.hoisted(() => ({
  confirm: vi.fn(),
  deleteSession: vi.fn<() => Promise<AiVaultDeleteSessionResult>>()
}))
vi.mock('@/components/confirmation-dialog-context', () => ({
  useConfirmationDialog: () => confirm
}))
vi.mock('sonner', () => ({ toast: { success: vi.fn(), error: vi.fn() } }))

const session: AiVaultSession = {
  id: 'codex:session',
  executionHostId: 'local',
  agent: 'codex',
  sessionId: '019f0000-1111-7222-8333-000000000001',
  title: 'Fix tests',
  cwd: '/repo',
  branch: null,
  model: null,
  filePath: '/codex/sessions/rollout.jsonl',
  codexHome: '/codex',
  createdAt: null,
  updatedAt: null,
  modifiedAt: '2026-10-11',
  messageCount: 1,
  totalTokens: 0,
  previewMessages: [],
  queuedMessageCount: 0,
  subagentTranscriptCount: 0,
  resumeCommand: 'codex resume session',
  subagent: null
}

beforeEach(() => {
  vi.clearAllMocks()
  confirm.mockResolvedValue(true)
  Object.assign(window, { api: { aiVault: { deleteSession } } })
})
afterEach(cleanup)

describe('Codex history deletion action', () => {
  it('preserves the session when confirmation is cancelled', async () => {
    confirm.mockResolvedValue(false)
    const { result } = renderHook(() => useAiVaultSessionDeleteAction({ refresh: vi.fn() }))
    await result.current(session)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }))
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it.each(['unsupported', 'active', 'incomplete'] as const)(
    'keeps the row and reports %s without showing a success toast',
    async (detail) => {
      deleteSession.mockResolvedValue({
        outcome: 'failed',
        agent: 'codex',
        error: 'private detail',
        detail
      })
      const refresh = vi.fn()
      const onDeleted = vi.fn()
      const { result } = renderHook(() => useAiVaultSessionDeleteAction({ refresh, onDeleted }))
      await result.current(session)
      expect(toast.error).toHaveBeenCalledTimes(1)
      expect(toast.error).not.toHaveBeenCalledWith('private detail')
      expect(toast.success).not.toHaveBeenCalled()
      expect(onDeleted).not.toHaveBeenCalled()
      expect(refresh).not.toHaveBeenCalled()
    }
  )

  it('allows a failed deletion to be retried and refreshes only after cleanup succeeds', async () => {
    deleteSession
      .mockResolvedValueOnce({
        outcome: 'failed',
        agent: 'codex',
        error: 'remaining',
        detail: 'incomplete'
      })
      .mockResolvedValueOnce({ outcome: 'deleted' })
    const refresh = vi.fn().mockResolvedValue(undefined)
    const onDeleted = vi.fn()
    const { result } = renderHook(() => useAiVaultSessionDeleteAction({ refresh, onDeleted }))
    await result.current(session)
    expect(onDeleted).not.toHaveBeenCalled()
    await result.current(session)
    expect(deleteSession).toHaveBeenLastCalledWith({
      agent: 'codex',
      sessionId: session.sessionId,
      filePath: session.filePath,
      executionHostId: 'local'
    })
    expect(onDeleted).toHaveBeenCalledWith(session)
    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledWith({ force: true })
  })
})
