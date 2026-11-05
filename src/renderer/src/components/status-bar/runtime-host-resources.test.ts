import { describe, expect, it, vi } from 'vitest'

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, values?: Record<string, string>) =>
    fallback.replace('{{value0}}', values?.value0 ?? '')
}))

import {
  collectRuntimeResourceEnvironmentIds,
  getRuntimeHostResourceNotices,
  readRuntimeHostResources,
  toRuntimeHostResourceSamples
} from './runtime-host-resources'

describe('runtime host resources', () => {
  it('polls only paired servers that host this client’s workspaces', () => {
    expect(
      collectRuntimeResourceEnvironmentIds([
        'local',
        'ssh:box',
        'runtime:env%20b',
        'runtime:env-a',
        'runtime:env-a',
        undefined
      ])
    ).toEqual(['env b', 'env-a'])
  })

  it("keeps a server's well-formed rows and drops malformed ones", async () => {
    const call = vi.fn().mockResolvedValue({
      worktrees: [
        {
          worktreeId: 'r::/w',
          worktreeName: 'w',
          repoId: 'r',
          repoName: 'R',
          cpu: 3,
          memory: 30,
          history: [10, 'x', 30],
          sessions: [
            { sessionId: 's1', paneKey: 'tab:1', pid: 4, cpu: 3, memory: 30 },
            { sessionId: 's2', cpu: 'bad', memory: 1 }
          ],
          extra: true
        },
        { worktreeId: 'r::/broken', repoId: 'r', cpu: Number.NaN, memory: 1 },
        null
      ]
    })

    await expect(readRuntimeHostResources('env-a', call)).resolves.toEqual({
      status: 'sampled',
      worktrees: [
        {
          worktreeId: 'r::/w',
          worktreeName: 'w',
          repoId: 'r',
          repoName: 'R',
          cpu: 3,
          memory: 30,
          history: [10, 30],
          sessions: [{ sessionId: 's1', paneKey: 'tab:1', pid: 4, cpu: 3, memory: 30 }]
        }
      ]
    })
    expect(call).toHaveBeenCalledWith('env-a')
  })

  it('says a server that cannot answer is unknown, never idle', async () => {
    const missing = Object.assign(new Error('nope'), { code: 'method_not_found' })
    const results = {
      old: await readRuntimeHostResources('old', vi.fn().mockRejectedValue(missing)),
      gone: await readRuntimeHostResources('gone', vi.fn().mockRejectedValue(new Error('timeout'))),
      odd: await readRuntimeHostResources('odd', vi.fn().mockResolvedValue({ worktrees: 'no' }))
    }

    expect(results).toEqual({
      old: { status: 'update-required' },
      gone: { status: 'unreachable' },
      odd: { status: 'update-required' }
    })
    const label = (id: string): string => `Host ${id}`
    expect(toRuntimeHostResourceSamples(results, label)).toEqual([])
    expect(getRuntimeHostResourceNotices(results, label)).toEqual([
      'Update Host old to see its resources.',
      "Couldn't reach Host gone; its resources are unknown.",
      'Update Host odd to see its resources.'
    ])
  })

  it('tags sampled rows with the server host id and name', () => {
    expect(
      toRuntimeHostResourceSamples({ 'env b': { status: 'sampled', worktrees: [] } }, () => 'Lab')
    ).toEqual([{ hostId: 'runtime:env%20b', hostLabel: 'Lab', worktrees: [] }])
  })
})
