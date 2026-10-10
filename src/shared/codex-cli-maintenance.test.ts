import { describe, expect, it } from 'vitest'
import { codexCliInstallation } from './codex-cli-installation'
import { CodexMaintenanceStateSchema } from './codex-cli-maintenance'
import {
  agentSessionRefusalFailure,
  parseAgentSessionWriteFailure
} from './agent-session-write-failure'

describe('Codex maintenance mixed-version replies', () => {
  it.each([null, '0.135.0'])(
    'retains the checked failure facts after a reload: %s',
    (installedVersion) => {
      const refusal = agentSessionRefusalFailure({
        code: 'agent_session_operation_invalid',
        details: {
          reason: 'attachFailed',
          codexInstallation: { installedVersion, minimumVersion: '0.136.0' }
        }
      })
      const saved = JSON.parse(JSON.stringify(refusal))
      expect(parseAgentSessionWriteFailure(saved)).toEqual(refusal)
      expect(refusal).toMatchObject({
        details: { codexInstallation: { installedVersion, minimumVersion: '0.136.0' } }
      })
    }
  )
  it('degrades newer host states without dropping version evidence or the log', () => {
    const result = CodexMaintenanceStateSchema.parse({
      installation: {
        status: 'future-health-state',
        version: '0.150.0',
        minimumVersion: '0.136.0'
      },
      canRun: true,
      job: {
        id: 'job',
        phase: 'future-phase',
        output: 'host log',
        exitCode: null,
        error: null
      }
    })
    expect(result.installation.status).toBe('unknown')
    expect(result.installation.version).toBe('0.150.0')
    expect(result.job?.phase).toBe('unknown')
    expect(result.job?.output).toBe('host log')
  })
  it('accepts optional current-job and expiry evidence while preserving legacy replies', () => {
    const legacy = {
      installation: codexCliInstallation(false, null),
      canRun: true,
      job: null
    }
    expect(CodexMaintenanceStateSchema.parse(legacy)).toEqual(legacy)
    const current = {
      ...legacy,
      currentJob: null,
      evidence: { expiresAt: 30_000, configurationId: 'opaque' }
    }
    expect(CodexMaintenanceStateSchema.parse(current)).toEqual(current)
  })
  it('keeps latest activity compact when reading a historical log', () => {
    const job = {
      id: 'job',
      phase: 'running',
      output: 'historical output',
      exitCode: null,
      error: null
    }
    const reply = CodexMaintenanceStateSchema.parse({
      installation: codexCliInstallation(false, null),
      canRun: true,
      job,
      currentJob: job
    })
    expect(reply.currentJob).toEqual({ id: 'job', phase: 'running' })
    expect(reply.job?.output).toBe('historical output')
  })
})
