import { describe, expect, it } from 'vitest'
import { getLocalCommandSourcePolicyNotice } from './RepositoryHooksSection'

describe('getLocalCommandSourcePolicyNotice', () => {
  it('does not show a notice when no local scripts are saved', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: '',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toBeNull()
  })

  it('does not show a notice when command source already includes local scripts', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'local-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: true
      })
    ).toBeNull()

    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'run-both',
        setupScript: '',
        archiveScript: 'echo archive',
        hasSharedScript: true
      })
    ).toBeNull()
  })

  it('waits for hook inspection before recommending a command source', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: false,
        currentPolicy: 'shared-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toEqual({ kind: 'checking' })
  })

  it('recommends local commands when local scripts are saved and no shared script exists', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: 'pnpm install',
        archiveScript: '',
        hasSharedScript: false
      })
    ).toEqual({ kind: 'action', policy: 'local-only', label: 'Use local commands' })
  })

  it('recommends run-both when local and shared scripts both exist', () => {
    expect(
      getLocalCommandSourcePolicyNotice({
        hooksInspectionReady: true,
        currentPolicy: 'shared-only',
        setupScript: '',
        archiveScript: 'echo archive',
        hasSharedScript: true
      })
    ).toEqual({ kind: 'action', policy: 'run-both', label: 'Run both' })
  })
})
