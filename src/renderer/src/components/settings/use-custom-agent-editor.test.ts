// @vitest-environment happy-dom

// Seed-lock behavior of the editor controller: an edit-mode open clears the
// previous draft before its fetch, a pending or failed seed locks fields and
// refuses submit, and only a successful seed unlocks the form.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { act, renderHook, waitFor } from '@testing-library/react'
import type { CustomTuiAgentId } from '../../../../shared/types'
import type { LocalCustomAgentDraftResult } from '../../../../shared/agent-catalog-snapshot'
import type { CustomAgentEditorMode } from './custom-agent-editor-state'

const mocks = vi.hoisted(() => ({
  mutateAgentCatalog: vi.fn()
}))

vi.mock('@/lib/agent-catalog-authoring', () => ({
  mutateAgentCatalog: mocks.mutateAgentCatalog
}))

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: null }) }
}))

import { useCustomAgentEditor } from './use-custom-agent-editor'

const AGENT_A = 'custom-agent:codex:aaa' as CustomTuiAgentId
const AGENT_B = 'custom-agent:codex:bbb' as CustomTuiAgentId

const getLocal = vi.fn()
const getLocalDraft = vi.fn<() => Promise<LocalCustomAgentDraftResult>>()

function readyDraft(label: string): LocalCustomAgentDraftResult {
  return {
    status: 'ready',
    revision: 1,
    draft: { label, commandOverride: null, args: '--x', env: {}, syncEnv: false }
  }
}

function renderEditor(initialMode: CustomAgentEditorMode) {
  return renderHook(
    ({ mode }: { mode: CustomAgentEditorMode }) =>
      useCustomAgentEditor({
        open: true,
        mode,
        initialBaseAgent: 'codex',
        onSaved: vi.fn(),
        onClose: vi.fn()
      }),
    { initialProps: { mode: initialMode } }
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  getLocal.mockResolvedValue({ revision: 1 })
  ;(window as unknown as { api: unknown }).api = {
    settings: { agentCatalog: { getLocal, getLocalDraft } }
  }
})

describe('useCustomAgentEditor seed locking', () => {
  it('locks fields and refuses submit while the edit seed is in flight', async () => {
    let resolveDraft: ((result: LocalCustomAgentDraftResult) => void) | null = null
    getLocalDraft.mockImplementationOnce(
      () => new Promise<LocalCustomAgentDraftResult>((resolve) => (resolveDraft = resolve))
    )
    const { result } = renderEditor({ kind: 'edit', id: AGENT_A })

    expect(result.current.loading).toBe(true)
    expect(result.current.inputsLocked).toBe(true)
    // Keystrokes during load must not land (a late seed would wipe them anyway).
    act(() => result.current.updateField({ label: 'typed during load' }))
    expect(result.current.draft.label).toBe('')
    await act(async () => {
      await result.current.submit()
    })
    expect(mocks.mutateAgentCatalog).not.toHaveBeenCalled()

    await act(async () => resolveDraft?.(readyDraft('Seeded Agent')))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.inputsLocked).toBe(false)
    expect(result.current.draft.label).toBe('Seeded Agent')
    act(() => result.current.updateField({ label: 'edited' }))
    expect(result.current.draft.label).toBe('edited')
  })

  it('keeps the form locked and non-submittable after a failed seed', async () => {
    getLocalDraft.mockResolvedValueOnce({
      status: 'too-large',
      revision: 1,
      bytes: 2_000_000,
      maxBytes: 1_048_576
    })
    const { result } = renderEditor({ kind: 'edit', id: AGENT_A })

    await waitFor(() => expect(result.current.seedFailed).toBe(true))
    expect(result.current.loading).toBe(false)
    expect(result.current.inputsLocked).toBe(true)
    expect(result.current.formError).not.toBeNull()

    act(() => result.current.updateField({ label: 'should not land' }))
    expect(result.current.draft.label).toBe('')
    await act(async () => {
      await result.current.submit()
    })
    // A failed seed must never reach update-custom: the client draft is not the record.
    expect(mocks.mutateAgentCatalog).not.toHaveBeenCalled()
  })

  it('clears the previous agent draft before seeding a newly addressed identity', async () => {
    getLocalDraft.mockResolvedValueOnce(readyDraft('Agent A'))
    const { result, rerender } = renderEditor({ kind: 'edit', id: AGENT_A })
    await waitFor(() => expect(result.current.draft.label).toBe('Agent A'))

    let resolveDraft: ((value: LocalCustomAgentDraftResult) => void) | null = null
    getLocalDraft.mockImplementationOnce(
      () => new Promise<LocalCustomAgentDraftResult>((resolve) => (resolveDraft = resolve))
    )
    rerender({ mode: { kind: 'edit', id: AGENT_B } })
    // Agent A's fields (which may hold env secrets) never show under B's identity.
    expect(result.current.draft.label).toBe('')
    expect(result.current.loading).toBe(true)

    // The seed fetches the snapshot revision before the draft; wait for the
    // draft request to be issued before resolving it.
    await waitFor(() => expect(resolveDraft).not.toBeNull())
    await act(async () => resolveDraft?.(readyDraft('Agent B')))
    await waitFor(() => expect(result.current.draft.label).toBe('Agent B'))
  })

  it('unlocks re-opens after a failed seed once the next seed succeeds', async () => {
    getLocalDraft.mockResolvedValueOnce({
      status: 'too-large',
      revision: 1,
      bytes: 2_000_000,
      maxBytes: 1_048_576
    })
    const { result, rerender } = renderEditor({ kind: 'edit', id: AGENT_A })
    await waitFor(() => expect(result.current.seedFailed).toBe(true))

    getLocalDraft.mockResolvedValueOnce(readyDraft('Agent B'))
    rerender({ mode: { kind: 'edit', id: AGENT_B } })
    await waitFor(() => expect(result.current.draft.label).toBe('Agent B'))
    expect(result.current.seedFailed).toBe(false)
    expect(result.current.inputsLocked).toBe(false)
  })
})
