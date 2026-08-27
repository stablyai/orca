import { describe, expect, it } from 'vitest'
import type { ExternalAutomationTarget } from '../../../../shared/automations-types'
import { toSshExecutionHostId } from '../../../../shared/execution-host'
import type { Repo } from '../../../../shared/repo-types'
import { repoMatchesExternalAutomationTarget } from './automation-external-target-match'

function repo(
  overrides: Partial<Pick<Repo, 'connectionId' | 'executionHostId'>> = {}
): Pick<Repo, 'connectionId' | 'executionHostId'> {
  return { connectionId: undefined, executionHostId: undefined, ...overrides }
}

const sshTarget: ExternalAutomationTarget = { type: 'ssh', connectionId: 'conn-1' }
const localTarget: ExternalAutomationTarget = { type: 'local' }

describe('repoMatchesExternalAutomationTarget', () => {
  it('matches a plain local repo against the local target', () => {
    expect(repoMatchesExternalAutomationTarget(repo(), localTarget)).toBe(true)
  })

  it('derives the ssh host from connectionId when executionHostId is unset', () => {
    expect(repoMatchesExternalAutomationTarget(repo({ connectionId: 'conn-1' }), sshTarget)).toBe(
      true
    )
  })

  it('rejects an ssh repo whose executionHostId points at another host despite matching connectionId', () => {
    expect(
      repoMatchesExternalAutomationTarget(
        repo({ connectionId: 'conn-1', executionHostId: toSshExecutionHostId('conn-2') }),
        sshTarget
      )
    ).toBe(false)
  })

  it('accepts an explicit executionHostId equal to the target host id', () => {
    expect(
      repoMatchesExternalAutomationTarget(
        repo({ connectionId: 'other-conn', executionHostId: toSshExecutionHostId('conn-1') }),
        sshTarget
      )
    ).toBe(true)
  })

  it('treats a runtime-owned execution host as not local even without a connectionId', () => {
    expect(
      repoMatchesExternalAutomationTarget(repo({ executionHostId: 'runtime:env-1' }), localTarget)
    ).toBe(false)
  })
})
