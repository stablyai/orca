import { describe, expect, it } from 'vitest'
import { PET_OMP_MODEL, buildPetOmpAgentArgs } from './pet-agent-spawn'

describe('buildPetOmpAgentArgs', () => {
  it('always asks for approval', () => {
    // A pet that can open ssh endpoints and browser panels is a real actor.
    // Dropping this flag is the mutation that matters: the spawn still works,
    // it just stops asking before it acts.
    expect(buildPetOmpAgentArgs()).toContain('--approval-mode always-ask')
  })

  it('pins the mesh assistant arm by default', () => {
    // Never cloud, never Ternary-Bonsai (64-76s, depth-only). If this default
    // drifts, the pet silently answers from a different model than speak-back.
    expect(buildPetOmpAgentArgs()).toContain(`--model ${PET_OMP_MODEL}`)
    expect(PET_OMP_MODEL).toBe('mesh-litellm/LFM2.5-8B-A1B-Q4_0.gguf')
  })

  it('lets the arm be overridden without touching the approval rule', () => {
    const args = buildPetOmpAgentArgs('mesh-litellm/other.gguf')
    expect(args).toContain('--model mesh-litellm/other.gguf')
    expect(args).toContain('--approval-mode always-ask')
  })
})
