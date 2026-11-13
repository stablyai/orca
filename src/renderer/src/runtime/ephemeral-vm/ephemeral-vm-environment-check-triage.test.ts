import { describe, expect, it } from 'vitest'
import type { EnvironmentDoctorCheck } from '../../../../shared/environment-doctor-types'
import { triageCloudEnvironmentChecks } from './ephemeral-vm-environment-check-triage'

const c = (
  id: string,
  status: EnvironmentDoctorCheck['status'],
  category: EnvironmentDoctorCheck['category'] = 'tools'
): EnvironmentDoctorCheck => ({ id, category, status, message: id })

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
        c('disk.free', 'warn', 'disk')
      ],
      { setupRunsOnCreate: false }
    )
    expect(fatal).toEqual([])
    expect(notices.map((notice) => [notice.id, notice.kind])).toEqual([
      ['git.push', 'push'],
      ['setup.run', 'setup'],
      ['disk.free', 'check']
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
      [c('git.fetch', 'fail', 'git'), c('disk.free', 'warn', 'disk')],
      { setupRunsOnCreate: true }
    )
    expect(fatal).toEqual([])
    expect(notices.map((notice) => [notice.id, notice.kind])).toEqual([
      ['git.fetch', 'fetch'],
      ['disk.free', 'check']
    ])
  })
})
