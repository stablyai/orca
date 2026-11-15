import { describe, expect, it } from 'vitest'
import { detectAgentSendTitleStatus } from './agent-send-title-status'

describe('detectAgentSendTitleStatus', () => {
  it('reads an Orca-launched Pi or OMP pane at rest as ready', () => {
    // Orca shows owned panes' `π - orca` / `π > orca` titles with the agent's own brand.
    expect(detectAgentSendTitleStatus('Pi - orca')).toBe('idle')
    expect(detectAgentSendTitleStatus('OMP > orca')).toBe('idle')
  })
})
