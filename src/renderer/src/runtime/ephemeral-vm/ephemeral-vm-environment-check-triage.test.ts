import { environmentHeldNotice } from './ephemeral-vm-environment-check-triage'
import { describe, expect, it } from 'vitest'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import {
  missingToolCommand,
  triageCloudEnvironmentChecks
} from './ephemeral-vm-environment-check-triage'

const c = (
  id: string,
  status: EnvironmentDoctorCheck['status'],
  category: EnvironmentDoctorCheck['category'] = 'tools'
): EnvironmentDoctorCheck => ({ id, category, status, message: id })
const disk = (code: 'diskLow' | 'diskVeryLow'): EnvironmentDoctorCheck => ({
  ...c('disk.free', code === 'diskLow' ? 'warn' : 'fail', 'disk'),
  code,
  params: { free: '0.8' }
})
const kinds = (checks: EnvironmentDoctorCheck[]): [string, string][] =>
  triageCloudEnvironmentChecks(checks, { setupRunsOnCreate: true }).notices.map((notice) => [
    notice.id,
    notice.kind
  ])

describe('triageCloudEnvironmentChecks', () => {
  it('stops only on a sandbox nobody can work in', () => {
    const { fatal } = triageCloudEnvironmentChecks(
      [
        c('environment.doctor', 'fail', 'workspace'),
        c('workspace.path', 'fail', 'workspace'),
        c('git.repo', 'fail', 'git'),
        c('tool.git', 'fail'),
        c('git.push', 'fail', 'git'),
        c('git.fetch', 'fail', 'git'),
        c('tool.pnpm', 'fail'),
        c('disk.free', 'fail', 'disk')
      ],
      { setupRunsOnCreate: true }
    )
    expect(fatal.map((check) => check.id)).toEqual([
      'environment.doctor',
      'workspace.path',
      'git.repo',
      'tool.git'
    ])
  })

  it('drops agent sign-in, advice, and passes; keeps push, setup and the rest as notices', () => {
    const { fatal, notices } = triageCloudEnvironmentChecks(
      [
        c('tool.git', 'pass'),
        c('agent.claude', 'warn', 'agents'),
        c('agent.cli', 'warn', 'agents'),
        c('git.push', 'fail', 'git'),
        c('setup.run', 'warn', 'setup'),
        c('setup.script', 'warn', 'setup'),
        c('git.remote', 'warn', 'git'),
        disk('diskLow')
      ],
      { setupRunsOnCreate: false }
    )
    expect(fatal).toEqual([])
    expect(notices.map((notice) => [notice.id, notice.kind])).toEqual([
      ['git.push', 'push'],
      ['setup.run', 'setup'],
      ['disk.free', 'disk']
    ])
  })

  it('says nothing about a setup script the create is about to run, or a push with no commits', () => {
    const { notices } = triageCloudEnvironmentChecks(
      [c('setup.run', 'warn', 'setup'), c('git.push', 'warn', 'git')],
      { setupRunsOnCreate: true }
    )
    expect(notices).toEqual([])
  })

  it('a failed reach of origin is its own notice, never a bare check line (ENV-ORIGIN-TOAST)', () => {
    const { fatal, notices } = triageCloudEnvironmentChecks(
      [c('git.fetch', 'fail', 'git'), disk('diskLow')],
      { setupRunsOnCreate: true }
    )
    expect(fatal).toEqual([])
    expect(notices.map((notice) => [notice.id, notice.kind])).toEqual([
      ['git.fetch', 'fetch'],
      ['disk.free', 'disk']
    ])
  })

  it('gives low disk and a missing tool their own kinds (ENV-NOTICE-ACTIONS)', () => {
    expect(
      kinds([
        disk('diskVeryLow'),
        {
          ...c('tool.pnpm', 'fail'),
          code: 'toolMissing',
          params: { command: 'pnpm', reason: 'pnpm-lock.yaml' }
        },
        // An older server: no code or params, the id still names the tool.
        c('tool.cargo', 'fail')
      ])
    ).toEqual([
      ['disk.free', 'disk'],
      ['tool.pnpm', 'tool'],
      ['tool.cargo', 'tool']
    ])
    expect(missingToolCommand(c('tool.cargo', 'fail'))).toBe('cargo')
  })

  it('hides what nobody can act on, and any check it has no words for, never a bare label', () => {
    expect(
      kinds([
        // "Could not read free disk space."
        c('disk.free', 'warn', 'disk'),
        // Checks from a newer doctor this desktop doesn't know.
        c('network.dns', 'fail', 'workspace'),
        c('cache.stale', 'warn', 'setup')
      ])
    ).toEqual([])
  })
})

describe('environmentHeldNotice (ENV-BUILD-CHURN)', () => {
  it('reads the held environment from the create log', () => {
    expect(
      environmentHeldNotice('[orca-cloud] booting\n[orca-cloud] environment-held env_0123abcd\n')
    ).toMatchObject({
      id: 'environment.held',
      kind: 'environmentHeld',
      environmentId: 'env_0123abcd'
    })
    expect(environmentHeldNotice('[orca-cloud] booting\n')).toBeNull()
    expect(environmentHeldNotice(undefined)).toBeNull()
  })
})
