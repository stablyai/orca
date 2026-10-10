import { describe, expect, it } from 'vitest'
import { resumeCandidateOwnership, resumeOwnershipLabel } from './native-chat-resume-ownership'

describe('whose interrupted chat this is', () => {
  it('takes the host’s answer, and never reads a missing or unknown one as the user’s', () => {
    expect(resumeCandidateOwnership({ origin: 'own' })).toBe('own')
    expect(resumeCandidateOwnership({ origin: 'server-made' })).toBe('server-made')
    expect(resumeCandidateOwnership({})).toBe('unknown')
  })

  it('labels every chat that does not start ticked, and none that does', () => {
    expect(resumeOwnershipLabel('own', 'studio-mac')).toBeUndefined()
    expect(resumeOwnershipLabel('automation', 'studio-mac')).toBe('Automation')
    expect(resumeOwnershipLabel('other-device', 'studio-mac')).toBe('Another device')
    expect(resumeOwnershipLabel('server-made', 'studio-mac')).toBe('Made on studio-mac')
    expect(resumeOwnershipLabel('unknown', 'studio-mac')).toBe('Unknown origin')
  })
})
