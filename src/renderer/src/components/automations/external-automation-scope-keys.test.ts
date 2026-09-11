import { describe, expect, it } from 'vitest'
import type { AutomationOwnerRef } from '../../../../shared/automation-owner-ref'
import {
  externalAutomationActionKey,
  externalAutomationDialogKey,
  externalAutomationJobKey,
  externalAutomationManagerKey,
  externalAutomationRunKey,
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

const local: ExternalAutomationScopeRef = { owner: localOwner, provider: 'hermes' }
const remote: ExternalAutomationScopeRef = { owner: sshOwner(), provider: 'hermes' }

describe('external automation scope keys', () => {
  it('separates the same provider ID across hosts', () => {
    expect(externalAutomationJobKey(local, 'job-1')).not.toBe(
      externalAutomationJobKey(remote, 'job-1')
    )
    expect(externalAutomationManagerKey(local, 'hermes:local')).not.toBe(
      externalAutomationManagerKey(remote, 'hermes:local')
    )
  })

  it('separates providers on one host', () => {
    expect(externalAutomationJobKey(local, 'job-1')).not.toBe(
      externalAutomationJobKey({ ...local, provider: 'openclaw' }, 'job-1')
    )
  })

  it('separates host incarnations, so a re-added target does not adopt old keys', () => {
    expect(externalAutomationScopeKey(remote)).not.toBe(
      externalAutomationScopeKey({ owner: sshOwner('t1', 4), provider: 'hermes' })
    )
  })

  it('keeps key kinds in separate namespaces', () => {
    const kinds = new Set([
      externalAutomationScopeKey(local),
      externalAutomationManagerKey(local, 'x'),
      externalAutomationJobKey(local, 'x'),
      externalAutomationRunKey(local, 'x', 'x'),
      externalAutomationActionKey(local, 'x', 'run'),
      externalAutomationDialogKey(local, 'x')
    ])
    expect(kinds.size).toBe(6)
  })

  it('distinguishes a create dialog from a job literally named new', () => {
    expect(externalAutomationDialogKey(local, null)).not.toBe(
      externalAutomationDialogKey(local, 'new')
    )
  })

  it('escapes components so a hostile ID cannot forge another key', () => {
    const forged = externalAutomationJobKey(local, 'job|extra')
    expect(forged).not.toBe(externalAutomationRunKey(local, 'job', 'extra'))
    expect(forged.split('|')).toHaveLength(4)
  })

  it('distinguishes actions on the same job', () => {
    expect(externalAutomationActionKey(local, 'job-1', 'run')).not.toBe(
      externalAutomationActionKey(local, 'job-1', 'delete')
    )
  })
})
