import { describe, expect, it } from 'vitest'
import { AUTOMATION_RUN_ENV_KEYS, buildAutomationRunEnv } from './automation-run-env'

const automation = { id: 'automation-1', name: 'Nightly triage' }

describe('buildAutomationRunEnv', () => {
  it('names the automation and the run', () => {
    expect(
      buildAutomationRunEnv({
        automation,
        run: { id: 'run-7', trigger: 'scheduled', runNumber: 7 }
      })
    ).toEqual({
      ORCA_AUTOMATION_ID: 'automation-1',
      ORCA_AUTOMATION_NAME: 'Nightly triage',
      ORCA_AUTOMATION_RUN_ID: 'run-7',
      ORCA_AUTOMATION_RUN_NUMBER: '7',
      ORCA_AUTOMATION_RUN_TRIGGER: 'scheduled'
    })
  })

  it('reports Run now as a manual trigger', () => {
    const env = buildAutomationRunEnv({
      automation,
      run: { id: 'run-8', trigger: 'manual', runNumber: 8 }
    })

    expect(env.ORCA_AUTOMATION_RUN_TRIGGER).toBe('manual')
  })

  // A run recorded before Orca tracked the number has none; an empty value would read as run 0.
  it('omits the run number rather than inventing one', () => {
    const env = buildAutomationRunEnv({
      automation,
      run: { id: 'run-legacy', trigger: 'scheduled', runNumber: undefined }
    })

    expect(Object.hasOwn(env, 'ORCA_AUTOMATION_RUN_NUMBER')).toBe(false)
    expect(env.ORCA_AUTOMATION_RUN_ID).toBe('run-legacy')
  })

  // The scrub and WSL-forwarding lists key off this constant, so it must cover what is emitted.
  it('emits only keys the forwarding lists know about', () => {
    const env = buildAutomationRunEnv({
      automation,
      run: { id: 'run-7', trigger: 'scheduled', runNumber: 7 }
    })

    expect(Object.keys(env).sort()).toEqual([...AUTOMATION_RUN_ENV_KEYS].sort())
  })
})
