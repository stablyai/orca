import { describe, expect, it } from 'vitest'
import { normalizeCompatibleAgentTitleForOwner } from '../../../../../shared/agent-status/title/agent-title-owner'
import { detectAgentSendTitleStatus } from './agent-send-title-status'

describe('detectAgentSendTitleStatus', () => {
  it('treats an Orca-launched Pi or OMP pane at rest as ready, as its pane shows it', () => {
    const piTitle = normalizeCompatibleAgentTitleForOwner('π - orca', 'pi')
    const ompTitle = normalizeCompatibleAgentTitleForOwner('π > orca', 'omp')

    expect(piTitle).toBe('Pi - orca')
    expect(ompTitle).toBe('OMP > orca')
    expect(detectAgentSendTitleStatus(piTitle)).toBe('idle')
    expect(detectAgentSendTitleStatus(ompTitle)).toBe('idle')
  })

  it('keeps a bare Pi name unproven and a Pi prompt as needing permission', () => {
    expect(detectAgentSendTitleStatus('Pi')).toBeNull()
    expect(detectAgentSendTitleStatus('Pi ! orca')).toBe('permission')
  })
})
