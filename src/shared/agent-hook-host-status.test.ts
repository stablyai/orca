import { describe, expect, it } from 'vitest'
import {
  describeAgentHookHost,
  formatAgentHookHostReports,
  summarizeAgentHookHostState
} from './agent-hook-host-status'
import type { AgentHookInstallStatus } from './agent-hook-types'

function status(
  agent: AgentHookInstallStatus['agent'],
  state: AgentHookInstallStatus['state']
): AgentHookInstallStatus {
  return { agent, state, configPath: '', managedHooksPresent: state === 'installed', detail: null }
}

describe('summarizeAgentHookHostState', () => {
  it('treats an empty result as unknown, not installed', () => {
    expect(summarizeAgentHookHostState([])).toBe('unknown')
  })

  it('is installed only when every agent installed', () => {
    expect(summarizeAgentHookHostState([status('claude', 'installed')])).toBe('installed')
    expect(
      summarizeAgentHookHostState([status('claude', 'installed'), status('codex', 'not_installed')])
    ).toBe('partial')
  })

  it('reports error only when nothing succeeded', () => {
    expect(summarizeAgentHookHostState([status('codex', 'error')])).toBe('error')
    expect(
      summarizeAgentHookHostState([status('claude', 'installed'), status('codex', 'error')])
    ).toBe('partial')
  })

  it('reports skipped when Orca deliberately installed nothing', () => {
    expect(summarizeAgentHookHostState([status('codex', 'skipped')])).toBe('skipped')
  })
})

describe('describeAgentHookHost', () => {
  it('names each host kind', () => {
    expect(describeAgentHookHost({ kind: 'local' })).toBe('local')
    expect(describeAgentHookHost({ kind: 'ssh', targetId: 't', label: 'box' })).toBe('ssh:box')
    expect(describeAgentHookHost({ kind: 'wsl', distro: 'Ubuntu' })).toBe('wsl:Ubuntu')
  })
})

describe('formatAgentHookHostReports', () => {
  it('prefixes every agent line with the host it belongs to', () => {
    const output = formatAgentHookHostReports([
      {
        host: { kind: 'local' },
        state: 'installed',
        detail: null,
        statuses: [status('codex', 'installed')]
      },
      {
        host: { kind: 'ssh', targetId: 't', label: 'box' },
        state: 'partial',
        detail: '1 agent hook install(s) failed on this host.',
        statuses: [status('codex', 'error')]
      }
    ])

    expect(output.split('\n')).toEqual([
      'local: installed',
      '  codex: installed',
      'ssh:box: partial — 1 agent hook install(s) failed on this host.',
      '  codex: error'
    ])
  })
})
