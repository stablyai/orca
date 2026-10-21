import { describe, expect, it } from 'vitest'
import {
  MACHINE_DISPLAY_STATES,
  getMachineActions,
  getMachineDisplayState,
  machineNeedsWake
} from './machine-display'

const ALL = ['create', 'sleep', 'wake', 'archive', 'delete', 'get']
const local = (state: string, verbs: readonly string[] = ALL) =>
  getMachineActions({ state, verbs, local: true, sshCommandAvailable: false })

describe('getMachineDisplayState', () => {
  it('folds provider states into the display vocabulary', () => {
    expect(getMachineDisplayState('creating')).toBe('starting')
    expect(getMachineDisplayState('waking')).toBe('starting')
    expect(getMachineDisplayState('stopping')).toBe('stopping')
    expect(getMachineDisplayState('error')).toBe('error')
    expect(getMachineDisplayState('unknown')).toBe('unreachable')
  })

  it('maps every provider state into the listed display states', () => {
    for (const state of [
      'creating',
      'running',
      'stopping',
      'sleeping',
      'waking',
      'archived',
      'error',
      'unknown',
      'unreachable',
      'gone'
    ]) {
      expect(MACHINE_DISPLAY_STATES).toContain(getMachineDisplayState(state))
    }
  })

  it('reads a state this build does not know as unreachable, never undefined', () => {
    expect(getMachineDisplayState('hibernating')).toBe('unreachable')
  })
})

describe('getMachineActions', () => {
  it('offers only what applies to each state', () => {
    expect(local('running')).toEqual(['sleep', 'archive', 'refresh', 'delete'])
    expect(local('sleeping')).toEqual(['wake', 'archive', 'refresh', 'delete'])
    expect(local('archived')).toEqual(['wake', 'refresh', 'delete'])
    expect(local('stopping')).toEqual(['refresh'])
    expect(local('waking')).toEqual(['refresh'])
    expect(local('unreachable')).toEqual(['refresh'])
    expect(local('gone')).toEqual(['refresh'])
  })

  it('lets a machine the provider reports in error be deleted', () => {
    expect(local('error')).toEqual(['refresh', 'delete'])
  })

  it('offers no verb the provider does not declare', () => {
    expect(local('running', [])).toEqual(['refresh'])
    expect(
      getMachineActions({
        state: 'running',
        verbs: undefined,
        local: true,
        sshCommandAvailable: false
      })
    ).toEqual(['refresh'])
    expect(local('sleeping', ['get', 'wake'])).toEqual(['wake', 'refresh'])
  })

  it("keeps a paired server's machines to Wake and Sleep", () => {
    expect(
      getMachineActions({ state: 'running', verbs: ALL, local: false, sshCommandAvailable: true })
    ).toEqual(['sleep'])
  })

  it('offers the SSH command only when one can be built', () => {
    expect(
      getMachineActions({ state: 'running', verbs: [], local: true, sshCommandAvailable: true })
    ).toEqual(['copy-ssh', 'refresh'])
  })
})

describe('machineNeedsWake', () => {
  it('wakes a sleeping, archived or still-stopping machine', () => {
    expect(['sleeping', 'archived', 'stopping', 'running', 'error'].map(machineNeedsWake)).toEqual([
      true,
      true,
      true,
      false,
      false
    ])
  })
})
