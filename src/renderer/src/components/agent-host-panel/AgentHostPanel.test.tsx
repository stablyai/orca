// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { Sheet } from '@/components/ui/sheet'
import type { OrcaCloudAgentsStatus } from '../../../../shared/orca-cloud-agents/orca-cloud-agents-wire'
import { CloudHostPanel } from './AgentHostPanel'
import type { ResolvedAgentHost } from './use-agent-host'

const STATUS: OrcaCloudAgentsStatus = {
  credentials: {
    claude: { state: 'active', label: 'a@acme.dev' },
    codex: { state: 'none' },
    providerEnabled: { claude: true, codex: true }
  },
  sources: { defaults: {}, coveredByKey: { claude: false, codex: false } }
}

/** Every bridge call the panel makes, by "namespace.method". */
function recordingApi(calls: string[]): unknown {
  const answer = (namespace: string, method: string): unknown => {
    switch (`${namespace}.${method}`) {
      case 'orcaCloudAgents.status':
        return Promise.resolve({ ok: true, value: STATUS })
      case 'orcaCloudAgents.setups':
        return Promise.resolve({ claude: { phase: 'idle' }, codex: { phase: 'idle' } })
      case 'orcaCloudAgents.onSetupChanged':
        return () => {}
      case 'orcaCloudAgents.workspaceSources':
        return Promise.resolve({ ok: true, value: STATUS.sources })
      case 'agentApiKeys.list':
        return Promise.resolve({ keys: [] })
      default:
        return Promise.resolve({ ok: false, error: 'unknown' })
    }
  }
  return new Proxy(
    {},
    {
      get: (_target, namespace) =>
        new Proxy(
          {},
          {
            get:
              (_inner, method) =>
              (..._args: unknown[]) => {
                calls.push(`${String(namespace)}.${String(method)}`)
                return answer(String(namespace), String(method))
              }
          }
        )
    }
  )
}

const HOST: ResolvedAgentHost = {
  hostId: 'runtime:env-1',
  label: 'Orca Cloud',
  kind: 'cloud',
  availability: 'asleep',
  environmentId: 'env-1',
  cloud: {
    workspaceId: 'repo-1::/w',
    workspaceLabel: 'acme/web · fix-auth',
    repoKey: 'github.com/acme/web',
    dot: 'sleeping'
  }
}

afterEach(() => cleanup())

describe('AgentHostPanel on Orca Cloud', () => {
  it('reads only the Orca account and Cloud secrets: it never wakes, starts, resumes or connects', async () => {
    const calls: string[] = []
    Object.defineProperty(window, 'api', { value: recordingApi(calls), configurable: true })
    render(
      <Sheet open>
        <CloudHostPanel host={HOST} focus={undefined} />
      </Sheet>
    )
    expect(await screen.findByText('From your Orca account · a@acme.dev')).toBeTruthy()
    await waitFor(() => expect(calls).toContain('orcaCloudAgents.workspaceSources'))
    expect(screen.getByText('Agent accounts & secrets')).toBeTruthy()
    expect(screen.getByText(/acme\/web · fix-auth · Orca Cloud · Asleep/)).toBeTruthy()
    // Section 1 rows are lists inside a labelled section.
    expect(screen.getAllByRole('region').length).toBeGreaterThanOrEqual(1)
    const forbidden = calls.filter((call) =>
      /wake|resume|start|connect|refreshEnv|getStatus|agentSignInStatus|signOut/i.test(call)
    )
    expect(forbidden).toEqual([])
    const allowed = new Set([
      'orcaCloudAgents.status',
      'orcaCloudAgents.setups',
      'orcaCloudAgents.onSetupChanged',
      'orcaCloudAgents.workspaceSources',
      'cloudSecrets.effective',
      'cloudSecrets.workspaceSharing',
      'orcaCloudEnvironments.list',
      'agentApiKeys.list'
    ])
    expect(calls.filter((call) => !allowed.has(call))).toEqual([])
  })
})
