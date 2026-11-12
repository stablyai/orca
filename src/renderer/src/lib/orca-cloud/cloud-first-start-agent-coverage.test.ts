// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'

const track = vi.fn()
vi.mock('@/diagnostics/telemetry/telemetry', () => ({ track: (...args: unknown[]) => track(...args) }))

const { noteComposerAgentCoverage, reportCloudStartAgentCoverage, resetCloudStartAgentCoverage } =
  await import('./cloud-first-start-agent-coverage')

describe('first cloud start agent coverage', () => {
  beforeEach(() => {
    track.mockClear()
    window.localStorage.clear()
    resetCloudStartAgentCoverage()
  })

  it('reports the first cloud start once, with what the Agent row showed', () => {
    noteComposerAgentCoverage({ kind: 'covered', agent: 'claude', via: 'team' })
    reportCloudStartAgentCoverage('claude')
    reportCloudStartAgentCoverage('claude')
    expect(track).toHaveBeenCalledTimes(1)
    expect(track).toHaveBeenCalledWith('cloud_first_start_agent_coverage', {
      agent: 'claude',
      coverage: 'key'
    })
  })

  it('reports unknown when the row showed another agent, and buckets other agents', () => {
    noteComposerAgentCoverage({ kind: 'notSetUp', agent: 'claude' })
    reportCloudStartAgentCoverage('cursor')
    expect(track).toHaveBeenCalledWith('cloud_first_start_agent_coverage', {
      agent: 'other',
      coverage: 'unknown'
    })
  })
})
