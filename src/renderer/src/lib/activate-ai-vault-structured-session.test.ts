import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { AiVaultSession } from '../../../shared/ai-vault-types'
import { activateAiVaultStructuredSession } from './activate-ai-vault-structured-session'

const structuredSession = {
  structuredSession: { sessionId: 'session-1', workspaceId: 'workspace-1' }
} as AiVaultSession

function deps(overrides: Partial<Parameters<typeof activateAiVaultStructuredSession>[1]> = {}) {
  return {
    activate: vi.fn(() => true),
    refresh: vi.fn(async () => undefined),
    reveal: vi.fn(async () => 'revealed' as const),
    unavailable: vi.fn(),
    gone: vi.fn(),
    hostCannotOpen: vi.fn(),
    ...overrides
  }
}

describe('activateAiVaultStructuredSession', () => {
  it('refreshes an unpublished structured tab before activating it', async () => {
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(true)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.refresh).toHaveBeenCalledWith('workspace-1')
    expect(parts.activate).toHaveBeenCalledTimes(2)
    // Why: the refresh alone answered, so the host was never asked to republish anything.
    expect(parts.reveal).not.toHaveBeenCalled()
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('reveals a session the inventory does not carry, then activates it', async () => {
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.reveal).toHaveBeenCalledWith({
      worktreeId: 'workspace-1',
      sessionId: 'session-1'
    })
    // The refresh after the reveal is what carries the republished tab into the store.
    expect(parts.refresh).toHaveBeenCalledTimes(2)
    expect(parts.activate).toHaveBeenCalledTimes(3)
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('says the chat is gone rather than asking for a retry that cannot succeed', async () => {
    // The host answered, and its answer was that it holds no such chat. Waiting cannot change it.
    const parts = deps({
      activate: vi.fn(() => false),
      reveal: vi.fn(async () => 'gone' as const)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.gone).toHaveBeenCalledOnce()
    expect(parts.unavailable).not.toHaveBeenCalled()
  })

  it('falls back to the retryable message when a revealed tab still does not arrive', async () => {
    const parts = deps({ activate: vi.fn(() => false) })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.reveal).toHaveBeenCalledOnce()
    expect(parts.unavailable).toHaveBeenCalledOnce()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('still reveals when the inventory refresh itself fails', async () => {
    // The refresh is an optimization. Letting its failure end the click reinstates the dead end
    // this whole path exists to remove: a closed chat, and advice to retry that cannot come true.
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValue(true),
      refresh: vi.fn().mockRejectedValueOnce(new Error('structured_session_restore_timeout'))
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.reveal).toHaveBeenCalledOnce()
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('does not strand the click when the post-reveal refresh fails', async () => {
    const parts = deps({
      activate: vi.fn().mockReturnValueOnce(false).mockReturnValueOnce(false).mockReturnValue(true),
      refresh: vi
        .fn()
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('structured_session_restore_timeout'))
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    // The reveal already emitted a snapshot of its own, so a failed confirmation refresh must not
    // discard a tab that has in fact arrived.
    expect(parts.activate).toHaveBeenCalledTimes(3)
    expect(parts.unavailable).not.toHaveBeenCalled()
    expect(parts.gone).not.toHaveBeenCalled()
  })

  it('offers an update rather than a eulogy when the host itself cannot open the chat', async () => {
    // The chat is not gone. Reporting it as gone hides the one remedy that would bring it back.
    const parts = deps({
      activate: vi.fn(() => false),
      reveal: vi.fn(async () => 'host-cannot-open' as const)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.hostCannotOpen).toHaveBeenCalledOnce()
    expect(parts.gone).not.toHaveBeenCalled()
    expect(parts.unavailable).not.toHaveBeenCalled()
  })

  it('keeps the retryable message when the host never answered', async () => {
    // Losing contact says nothing about the chat, so this is the one miss worth waiting out.
    const parts = deps({
      activate: vi.fn(() => false),
      reveal: vi.fn(async () => 'unreachable' as const)
    })

    await expect(activateAiVaultStructuredSession(structuredSession, parts)).resolves.toBe(true)

    expect(parts.unavailable).toHaveBeenCalledOnce()
    expect(parts.gone).not.toHaveBeenCalled()
    expect(parts.hostCannotOpen).not.toHaveBeenCalled()
  })

  it('runs one activation per session however many times the row is clicked', async () => {
    // Three clicks on a slow row used to run three full sequences and land three toasts.
    let release!: (outcome: 'gone') => void
    const pending = new Promise<'gone'>((resolve) => {
      release = resolve
    })
    const parts = deps({ activate: vi.fn(() => false), reveal: vi.fn(() => pending) })

    const clicks = [
      activateAiVaultStructuredSession(structuredSession, parts),
      activateAiVaultStructuredSession(structuredSession, parts),
      activateAiVaultStructuredSession(structuredSession, parts)
    ]
    release('gone')
    await Promise.all(clicks)

    expect(parts.reveal).toHaveBeenCalledOnce()
    expect(parts.gone).toHaveBeenCalledOnce()
  })

  it('ignores a row that is not a structured chat', async () => {
    const parts = deps()

    await expect(activateAiVaultStructuredSession({} as AiVaultSession, parts)).resolves.toBe(false)

    expect(parts.reveal).not.toHaveBeenCalled()
  })
})

describe('every Agent Session History entry point reaches the same reveal', () => {
  // A source ratchet rather than a mounted drag harness: what regresses here is a call site
  // quietly going back to bare activation, which cannot reach a chat whose tab is closed. Both
  // surfaces act on the identical row, so answering a click and a drop differently is the bug.
  const entryPoints = [
    'components/tab-group/AiVaultSessionDropLayer.tsx',
    'components/right-sidebar/ai-vault-session-launch-actions.ts'
  ]

  it.each(entryPoints)('%s routes its structured branch through the reveal path', (relative) => {
    const source = readFileSync(join(__dirname, '..', relative), 'utf8')

    expect(source).toContain('activateAiVaultStructuredSession(')
    expect(source).not.toContain('activateStructuredAgentSessionById')
  })
})
