import { describe, expect, it } from 'vitest'

import { projectAgentLaunchProfile } from './agent-launch/choices/agent-launch-profile'
import {
  agentPickerLaunchInputs,
  type AgentPickerEntry
} from './agent-launch/picker/agent-launch-picker'
import { hermesProfileArgs, isHermesProfileName, withHermesProfileArgs } from './hermes-profiles'

describe('Hermes profiles', () => {
  it('accepts only Hermes profile ids', () => {
    expect(isHermesProfileName('work')).toBe(true)
    expect(isHermesProfileName('work-2')).toBe(true)
    expect(isHermesProfileName('Bad Name')).toBe(false)
    expect(isHermesProfileName('../escape')).toBe(false)
    expect(isHermesProfileName('a'.repeat(65))).toBe(false)
  })

  it('adds the profile without dropping the saved arguments', () => {
    expect(withHermesProfileArgs('--yolo --model sonnet', 'work')).toBe(
      '--yolo --model sonnet --profile work'
    )
    expect(hermesProfileArgs('work')).toEqual(['--profile', 'work'])
  })

  it('replaces an existing profile selector', () => {
    expect(withHermesProfileArgs('--yolo --profile old', 'work')).toBe('--yolo --profile work')
    expect(withHermesProfileArgs('-p old --yolo', 'work')).toBe('--yolo --profile work')
    expect(withHermesProfileArgs('--profile=old --yolo', 'work')).toBe('--yolo --profile work')
  })

  it('removes the selector for the default profile', () => {
    expect(withHermesProfileArgs('--yolo --profile old', null)).toBe('--yolo')
    expect(withHermesProfileArgs('--profile=old', null)).toBe('')
  })

  it('keeps the profile before a terminator, where Hermes still reads it', () => {
    expect(withHermesProfileArgs('--yolo -- --profile not-ours', 'work')).toBe(
      '--yolo --profile work -- --profile not-ours'
    )
  })

  it('leaves invalid profile names and unparsable arguments alone', () => {
    expect(withHermesProfileArgs('--yolo', 'Bad Name')).toBe('--yolo')
    expect(withHermesProfileArgs('"unterminated', 'work')).toBe('"unterminated')
  })

  it('adds the profile to the arguments composed from saved settings', () => {
    const base = projectAgentLaunchProfile(
      'hermes',
      {
        agentDefaultArgs: { hermes: '--yolo --model sonnet' },
        agentPermissionDefault: 'own'
      },
      { target: 'terminal' }
    ).args

    expect(withHermesProfileArgs(base, 'work')).toBe('--yolo --model sonnet --profile work')
  })

  it('carries the profile through the picker launch inputs', () => {
    const entry: AgentPickerEntry = {
      agent: 'hermes',
      label: 'Hermes',
      rows: [{ agent: 'hermes', kind: 'cli' }],
      surfaces: ['terminal'],
      defaultSurface: 'terminal',
      terminal: {},
      structured: {},
      arguments: '--yolo',
      catalog: { origin: 'unknown' }
    }
    const inputs = agentPickerLaunchInputs(
      {
        agent: 'hermes',
        surface: 'terminal',
        choices: {},
        arguments: withHermesProfileArgs('--yolo', 'work')
      },
      entry
    )

    expect(inputs.agentArgs).toContain('--profile work')
  })
})
