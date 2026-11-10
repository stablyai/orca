import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState } from '@/store/types'
import { __resetTrustPromptChainForTests } from '../runtime/repo-hooks/ensure-hooks-confirmed'
import { confirmWorkspaceSetupDecision } from './workspace/creation/setup/workspace-setup-trust'

const hooksCheckMock = vi.fn()

function stateWithRepoWideTrust(kind: 'git' | 'folder'): AppState {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the trust check reads only trustedOrcaHooks, repos and openModal
  return {
    trustedOrcaHooks: { 'repo-1': { all: { approvedAt: 1 } } },
    repos: [{ id: 'repo-1', displayName: 'acme', kind }],
    openModal: () => {
      throw new Error('repo-wide trust must not prompt')
    }
  } as unknown as AppState
}

describe('confirmWorkspaceSetupDecision under whole-project trust', () => {
  beforeEach(() => {
    hooksCheckMock.mockReset().mockResolvedValue({
      status: 'ok',
      hasHooks: true,
      hooks: { scripts: { setup: 'make bootstrap' } },
      mayNeedUpdate: false
    })
    vi.stubGlobal('window', { api: { hooks: { check: hooksCheckMock } } })
    __resetTrustPromptChainForTests()
  })

  it('asks a folder host to run setup outright, since the trust carries no content hash', async () => {
    const result = await confirmWorkspaceSetupDecision(
      stateWithRepoWideTrust('folder'),
      'repo-1',
      'inherit',
      'local',
      () => false
    )
    expect(result).toMatchObject({ setupDecision: 'run', trustDecision: 'run' })
  })

  it('leaves a git create on the project policy', async () => {
    const result = await confirmWorkspaceSetupDecision(
      stateWithRepoWideTrust('git'),
      'repo-1',
      'inherit',
      'local',
      () => false
    )
    expect(result).toMatchObject({ setupDecision: 'inherit', trustDecision: 'run' })
  })
})
