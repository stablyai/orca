// @vitest-environment happy-dom

import { cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Toaster, toast } from 'sonner'
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
afterEach(() => {
  toast.dismiss()
  cleanup()
})

describe('Codex history deletion action', () => {
  it('preserves the session when confirmation is cancelled', async () => {
    confirm.mockResolvedValue(false)
    const { result } = renderHook(() => useAiVaultSessionDeleteAction({ refresh: vi.fn() }))
    await result.current(session)
    expect(confirm).toHaveBeenCalledWith(expect.objectContaining({ confirmVariant: 'destructive' }))
    expect(deleteSession).not.toHaveBeenCalled()
  })

  it('retries incomplete cleanup after a rescan removes the session row', async () => {
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
    function SessionRow() {
      const deleteAction = useAiVaultSessionDeleteAction({ refresh, onDeleted })
      return <button onClick={() => void deleteAction(session)}>Delete session</button>
    }
    function History({ sessions }: { sessions: AiVaultSession[] }) {
      return (
        <>
          <Toaster />
          {sessions.map((row) => (
            <SessionRow key={row.id} />
          ))}
        </>
      )
    }
    const { rerender } = render(<History sessions={[session]} />)
    fireEvent.click(screen.getByRole('button', { name: 'Delete session' }))
    await screen.findByRole('button', { name: 'Retry' })
    rerender(<History sessions={[]} />)
    expect(screen.queryByRole('button', { name: 'Delete session' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(onDeleted).toHaveBeenCalledWith(session))
    expect(deleteSession).toHaveBeenLastCalledWith({
      agent: 'codex',
      sessionId: session.sessionId,
      filePath: session.filePath,
      executionHostId: 'local'
    })
    expect(refresh).toHaveBeenCalledWith({ force: true })
  })
})
