/**
 * A write knows the host it addressed; these pin that it never widens that into
 * another host's rows, and never narrows an unknown host into a guessed one.
 */

import { describe, expect, it } from 'vitest'
import type { AutomationAuthorityRef } from '../../../../shared/automation-owner-ref'
import type { AutomationCapturedOwner } from './automation-captured-owner'
import {
  automationRowCatalogRef,
  automationWriteChangeEvent,
  stableAutomationAuthorityRef
} from './automation-write-invalidation'

const DESKTOP: AutomationAuthorityRef = { kind: 'desktop' }
const RUNTIME: AutomationAuthorityRef = {
  kind: 'runtime',
  environmentId: 'env-1',
  pairingRevision: 7
}

describe('automation write invalidation', () => {
  it('drops the incarnation from the authority', () => {
    expect(stableAutomationAuthorityRef(RUNTIME)).toEqual({
      kind: 'runtime',
      environmentId: 'env-1'
    })
    expect(stableAutomationAuthorityRef(DESKTOP)).toEqual({ kind: 'desktop' })
  })

  it('takes the host from the row owner, not the active authority', () => {
    const captured: AutomationCapturedOwner = {
      owner: {
        authority: RUNTIME,
        selector: { kind: 'ssh', targetId: 'target-1', targetGeneration: 3 }
      },
      selector: { kind: 'ssh', targetId: 'target-1' }
    }

    expect(automationRowCatalogRef(captured, DESKTOP)).toEqual({
      authority: { kind: 'runtime', environmentId: 'env-1' },
      selector: { kind: 'ssh', targetId: 'target-1' }
    })
  })

  it('falls back to the captured selector under the acting authority', () => {
    const captured: AutomationCapturedOwner = {
      owner: null,
      selector: { kind: 'orphan', issue: 'target-missing' }
    }

    expect(automationRowCatalogRef(captured, DESKTOP)).toEqual({
      authority: { kind: 'desktop' },
      selector: { kind: 'orphan' }
    })
  })

  it('names no host for a row that carried no metadata', () => {
    expect(automationRowCatalogRef({ owner: null, selector: null }, DESKTOP)).toBeNull()
  })

  it('widens to the whole authority rather than guessing a selector', () => {
    expect(automationWriteChangeEvent(null, RUNTIME)).toEqual({
      authority: { kind: 'runtime', environmentId: 'env-1' },
      reason: 'definition'
    })
  })

  it('scopes the event to the host the write named', () => {
    expect(
      automationWriteChangeEvent(
        { authority: { kind: 'desktop' }, selector: { kind: 'self' } },
        DESKTOP
      )
    ).toEqual({
      authority: { kind: 'desktop' },
      selector: { kind: 'self' },
      reason: 'definition'
    })
  })
})
