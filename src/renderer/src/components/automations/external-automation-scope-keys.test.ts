import { describe, expect, it } from 'vitest'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import {
  externalAutomationActionKey,
  externalAutomationJobKey,
  externalAutomationManagerKey,
  externalAutomationScopeKey,
  type ExternalAutomationScopeRef
} from './external-automation-scope-keys'

const localOwner: AutomationOwnerRef = {
  authority: { kind: 'desktop' },
  selector: { kind: 'self' }
}
const sshOwner = (targetId = 't1', targetGeneration = 3): AutomationOwnerRef => ({
  authority: { kind: 'desktop' },
  selector: { kind: 'ssh', targetId, targetGeneration }
})

const local: ExternalAutomationScopeRef = { owner: localOwner, provider: 'openclaw' }
const remote: ExternalAutomationScopeRef = { owner: sshOwner(), provider: 'openclaw' }

describe('external automation scope keys', () => {
  it('separates the same provider ID across hosts', () => {
    expect(externalAutomationJobKey(local, 'job-1')).not.toBe(
      externalAutomationJobKey(remote, 'job-1')
    )
    expect(externalAutomationManagerKey(local, 'openclaw:local')).not.toBe(
      externalAutomationManagerKey(remote, 'openclaw:local')
    )
  })

  it('separates host incarnations, so a re-added target does not adopt old keys', () => {
    expect(externalAutomationScopeKey(remote)).not.toBe(
      externalAutomationScopeKey({ owner: sshOwner('t1', 4), provider: 'openclaw' })
    )
  })

  it('keeps key kinds in separate namespaces', () => {
    const kinds = new Set([
      externalAutomationScopeKey(local),
      externalAutomationManagerKey(local, 'x'),
      externalAutomationJobKey(local, 'x'),
      externalAutomationActionKey(local, 'x', 'run')
    ])
    expect(kinds.size).toBe(4)
  })

  it('escapes components so a hostile ID cannot forge another key', () => {
    const forged = externalAutomationJobKey(local, 'job|extra')
    expect(forged).not.toBe(externalAutomationActionKey(local, 'job', 'run'))
    expect(forged).not.toBe(externalAutomationJobKey(local, 'job%7Cextra'))
    expect(externalAutomationActionKey(local, 'job|extra', 'run')).not.toBe(
      externalAutomationActionKey(local, 'job%7Cextra', 'run')
    )
    expect(forged.split('|')).toHaveLength(4)
  })

  it('distinguishes actions on the same job', () => {
    expect(externalAutomationActionKey(local, 'job-1', 'run')).not.toBe(
      externalAutomationActionKey(local, 'job-1', 'delete')
    )
  })
})
