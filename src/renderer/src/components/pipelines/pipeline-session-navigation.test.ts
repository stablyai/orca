import { afterEach, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store'
import { openPipelineSession } from './pipeline-session-navigation'
import { workspace } from './pipeline-run.fixture-data'

afterEach(() => vi.unstubAllGlobals())
it('refuses terminal navigation when the workspace instance changes during identity lookup', async () => {
  const previous = useAppStore.getState()
  const lookup = Promise.withResolvers<unknown>()
  const paneKey = 'saved-tab:11111111-1111-4111-8111-111111111111'
  useAppStore.setState({
    worktreesByRepo: { [workspace.repoId]: [workspace] },
    unifiedTabsByWorktree: {}
  })
  vi.stubGlobal('window', { api: { runtime: { call: () => lookup.promise } } })
  try {
    const opening = openPipelineSession(
      workspace,
      {
        kind: 'terminal',
        sessionId: 'saved-session',
        terminalHandle: 'saved-handle',
        paneKey,
        compatibilityKey: 'c'.repeat(64)
      },
      'saved-runtime'
    )
    useAppStore.setState({
      worktreesByRepo: {
        [workspace.repoId]: [{ ...workspace, instanceId: 'replacement-instance' }]
      }
    })
    lookup.resolve({
      ok: true,
      result: {
        terminal: {
          worktreeId: workspace.id,
          connected: true,
          writable: true,
          ptyId: 'saved-pty',
          tabId: 'saved-tab',
          leafId: '11111111-1111-4111-8111-111111111111'
        }
      },
      _meta: { runtimeId: 'saved-runtime' }
    })
    await expect(opening).rejects.toThrow('pipeline_workspace_instance_changed')
  } finally {
    useAppStore.setState(previous, true)
  }
})
