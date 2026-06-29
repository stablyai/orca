import { describe, expect, it } from 'vitest'
import { getEphemeralVmSetupProgress } from './ephemeral-vm-setup-progress'

describe('getEphemeralVmSetupProgress', () => {
  it('counts nothing confirmed in a fresh state', () => {
    const progress = getEphemeralVmSetupProgress({
      orcaCliReady: false,
      skillInstalled: false,
      recipeCount: 0,
      doctorOk: false
    })
    expect(progress.doneCount).toBe(0)
    expect(progress.total).toBe(4)
    expect(progress.firstIncompleteStepId).toBe('prerequisites')
    expect(progress.stepDone).toEqual({
      prerequisites: false,
      skill: false,
      scaffold: false,
      validate: false
    })
  })

  it('confirms prerequisites once the Orca CLI is detected', () => {
    const progress = getEphemeralVmSetupProgress({
      orcaCliReady: true,
      skillInstalled: false,
      recipeCount: 0,
      doctorOk: false
    })
    expect(progress.stepDone.prerequisites).toBe(true)
    expect(progress.firstIncompleteStepId).toBe('skill')
    expect(progress.doneCount).toBe(1)
  })

  it('treats a discovered recipe as the scaffold-step proxy but does not infer doctor', () => {
    const progress = getEphemeralVmSetupProgress({
      orcaCliReady: true,
      skillInstalled: true,
      recipeCount: 2,
      doctorOk: false
    })
    expect(progress.stepDone.scaffold).toBe(true)
    expect(progress.stepDone.validate).toBe(false)
    expect(progress.firstIncompleteStepId).toBe('validate')
    expect(progress.doneCount).toBe(3)
  })

  it('reports all confirmed only when doctor passes on a real recipe', () => {
    const progress = getEphemeralVmSetupProgress({
      orcaCliReady: true,
      skillInstalled: true,
      recipeCount: 1,
      doctorOk: true
    })
    expect(progress.firstIncompleteStepId).toBeNull()
    expect(progress.doneCount).toBe(4)
  })

  it('does not let a passing doctor mask missing earlier steps', () => {
    const progress = getEphemeralVmSetupProgress({
      orcaCliReady: false,
      skillInstalled: false,
      recipeCount: 1,
      doctorOk: true
    })
    // validate is done, but the earliest incomplete step is still surfaced first
    expect(progress.stepDone.validate).toBe(true)
    expect(progress.firstIncompleteStepId).toBe('prerequisites')
    expect(progress.doneCount).toBe(2)
  })
})
