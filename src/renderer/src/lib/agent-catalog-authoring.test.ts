import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GlobalSettings, TerminalQuickCommand } from '../../../shared/types'
import {
  applyAgentPermissionModeViaCatalog,
  deleteTerminalQuickCommand,
  saveCommitMessageAiSettings,
  saveSourceControlAiSettings,
  saveTerminalQuickCommand,
  setDefaultTuiAgent,
  setTuiAgentEnabled,
  setTuiAgentEnabledAtRevision,
  updateBuiltInTuiAgent
} from './agent-catalog-authoring'

const storeSettings: { current: Partial<GlobalSettings> } = { current: {} }

vi.mock('@/store', () => ({
  useAppStore: { getState: () => ({ settings: storeSettings.current }) }
}))

const catalogGetLocal = vi.fn()
const catalogMutate = vi.fn()
const referenceGetLocal = vi.fn()
const referenceMutate = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  storeSettings.current = {}
  catalogGetLocal.mockResolvedValue({ revision: 5 })
  catalogMutate.mockResolvedValue({ ok: true, revision: 6, snapshot: { revision: 6 } })
  referenceGetLocal.mockResolvedValue({ revision: 3 })
  referenceMutate.mockResolvedValue({
    ok: true,
    referenceRevision: 4,
    catalogRevision: 6,
    snapshot: { revision: 4 }
  })
  ;(globalThis as unknown as { window: unknown }).window = {
    api: {
      settings: {
        agentCatalog: { getLocal: catalogGetLocal, mutate: catalogMutate },
        agentReferences: { getLocal: referenceGetLocal, mutate: referenceMutate }
      }
    }
  }
})

describe('agent-catalog authoring writes', () => {
  it('maps a null default to the Auto catalog mutation at the current revision', async () => {
    await setDefaultTuiAgent(null)

    expect(catalogMutate).toHaveBeenCalledWith({
      expectedRevision: 5,
      mutation: { kind: 'set-default', agent: 'auto' }
    })
  })

  it('passes a concrete default agent straight through', async () => {
    await setDefaultTuiAgent('codex')

    expect(catalogMutate).toHaveBeenCalledWith({
      expectedRevision: 5,
      mutation: { kind: 'set-default', agent: 'codex' }
    })
  })

  it('toggles availability through the set-enabled mutation', async () => {
    await setTuiAgentEnabled('claude', false)

    expect(catalogMutate).toHaveBeenCalledWith({
      expectedRevision: 5,
      mutation: { kind: 'set-enabled', agent: 'claude', enabled: false }
    })
  })

  it('disables at a captured revision without fetching or auto-retrying', async () => {
    // The confirm flow supplies the revision the user saw; a conflict must
    // surface (not silently reapply) so the dialog can refresh (plan §973).
    catalogMutate.mockResolvedValueOnce({
      ok: false,
      code: 'catalog_revision_conflict',
      revision: 9,
      snapshot: { revision: 9 }
    })

    const result = await setTuiAgentEnabledAtRevision('custom-agent:claude:one' as never, false, 3)

    expect(catalogGetLocal).not.toHaveBeenCalled()
    expect(catalogMutate).toHaveBeenCalledTimes(1)
    expect(catalogMutate).toHaveBeenCalledWith({
      expectedRevision: 3,
      mutation: { kind: 'set-enabled', agent: 'custom-agent:claude:one', enabled: false }
    })
    expect(result.ok).toBe(false)
  })

  it('carries the current command and env when only the args field changes', async () => {
    storeSettings.current = {
      agentCmdOverrides: { claude: '/opt/claude' },
      agentDefaultArgs: { claude: '--old' },
      agentDefaultEnv: { claude: { KEY: 'VALUE' } }
    }

    await updateBuiltInTuiAgent('claude', { args: '--new' })

    expect(catalogMutate).toHaveBeenCalledWith({
      expectedRevision: 5,
      mutation: {
        kind: 'update-built-in',
        agent: 'claude',
        changes: { commandOverride: '/opt/claude', args: '--new', env: { KEY: 'VALUE' } }
      }
    })
  })

  it('refreshes the revision and retries once on a catalog conflict', async () => {
    catalogMutate
      .mockResolvedValueOnce({ ok: false, code: 'catalog_revision_conflict', revision: 9 })
      .mockResolvedValueOnce({ ok: true, revision: 10, snapshot: { revision: 10 } })

    await setDefaultTuiAgent('codex')

    expect(catalogMutate).toHaveBeenCalledTimes(2)
    expect(catalogMutate).toHaveBeenLastCalledWith({
      expectedRevision: 9,
      mutation: { kind: 'set-default', agent: 'codex' }
    })
  })

  it('decomposes a permission-mode change into per-agent built-in mutations', async () => {
    storeSettings.current = { agentDefaultArgs: {}, agentDefaultEnv: {} }

    await applyAgentPermissionModeViaCatalog('yolo', { agentDefaultArgs: {}, agentDefaultEnv: {} })

    const claudeCall = catalogMutate.mock.calls.find(
      ([request]) =>
        request.mutation.kind === 'update-built-in' && request.mutation.agent === 'claude'
    )
    expect(claudeCall?.[0].mutation.changes).toEqual({
      commandOverride: null,
      args: '--dangerously-skip-permissions',
      env: {}
    })
    expect(
      catalogMutate.mock.calls.every(([request]) => request.mutation.kind === 'update-built-in')
    ).toBe(true)
  })

  it('saves a quick command through the reference mutation at its revision', async () => {
    const command = {
      id: 'qc-1',
      label: 'Build',
      command: 'npm run build',
      appendEnter: true
    } as unknown as TerminalQuickCommand

    await saveTerminalQuickCommand(command)

    expect(referenceMutate).toHaveBeenCalledWith({
      expectedReferenceRevision: 3,
      mutation: { kind: 'quick-command-save', command }
    })
  })

  it('deletes a quick command by id', async () => {
    await deleteTerminalQuickCommand('qc-1')

    expect(referenceMutate).toHaveBeenCalledWith({
      expectedReferenceRevision: 3,
      mutation: { kind: 'quick-command-delete', id: 'qc-1' }
    })
  })

  it('routes commit-message and source-control edits to their reference mutations', async () => {
    await saveCommitMessageAiSettings({ enabled: true })
    await saveSourceControlAiSettings({ enabled: false })

    expect(referenceMutate).toHaveBeenCalledWith({
      expectedReferenceRevision: 3,
      mutation: { kind: 'commit-message-update', changes: { enabled: true } }
    })
    expect(referenceMutate).toHaveBeenCalledWith({
      expectedReferenceRevision: 3,
      mutation: { kind: 'source-control-update', changes: { enabled: false } }
    })
  })

  it('refreshes the reference revision and retries once on a conflict', async () => {
    referenceMutate
      .mockResolvedValueOnce({
        ok: false,
        code: 'reference_revision_conflict',
        referenceRevision: 7,
        catalogRevision: 6
      })
      .mockResolvedValueOnce({ ok: true, referenceRevision: 8, catalogRevision: 6, snapshot: {} })

    await deleteTerminalQuickCommand('qc-1')

    expect(referenceMutate).toHaveBeenCalledTimes(2)
    expect(referenceMutate).toHaveBeenLastCalledWith({
      expectedReferenceRevision: 7,
      mutation: { kind: 'quick-command-delete', id: 'qc-1' }
    })
  })
})
