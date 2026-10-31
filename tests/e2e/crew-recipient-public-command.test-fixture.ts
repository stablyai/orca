import { getWorkerTerminalAutoReleaseScheduler } from '../../src/main/runtime/orchestration/worker-terminal-auto-release-scheduler'
import { vi } from 'vitest'
import { z } from 'zod'
import { dispatch } from '../../src/cli/dispatch'
import { RuntimeClient, RuntimeClientError } from '../../src/cli/runtime-client'
import { readOrchestrationCompatibilityEvidence } from '../../src/shared/orchestration-compatibility-evidence'
import {
  createSessionCallerHarness,
  orchestrationRequest,
  WORKER_PANE
} from '../../src/main/runtime/rpc/orchestration-session-caller-test-fixture'

export function createOrdinaryCrewCommandFixture(
  hostRef: { current: unknown },
  actualIdentity = false,
  extraPanes: [string, string][] = []
) {
  const ref: { current: unknown } = { current: null }
  const h = createSessionCallerHarness(ref)
  h.records.clear()
  hostRef.current = ref.current
  const panes = new Map([
    ['term_worker', WORKER_PANE],
    ['term_peer', 'tab_peer:cccccccc-cccc-4ccc-8ccc-cccccccccccc'],
    ['term_helper', 'tab_helper:dddddddd-dddd-4ddd-8ddd-dddddddddddd'],
    ['term_coord', 'tab_coord:eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'],
    ...extraPanes
  ])
  if (actualIdentity) {
    vi.mocked(h.runtime.getTerminalPaneKey).mockRestore()
    vi.mocked(h.runtime.getLiveTerminalPaneKey).mockRestore()
    const surfaces = [...panes].map(([handle, pane]) => {
      const [tabId, leafId] = pane.split(':')
      if (!tabId || !leafId) {
        throw new Error('invalid terminal fixture pane')
      }
      return { handle, tabId, leafId, ptyId: `pty_crew_${handle}` }
    })
    for (const surface of surfaces) {
      h.runtime.registerPty(surface.ptyId, 'folder-worker-host', null, {
        tabId: surface.tabId,
        leafId: surface.leafId,
        incarnationId: 'original',
        terminalHandle: surface.handle
      })
    }
    h.runtime.attachWindow(1)
    h.runtime.syncWindowGraph(1, {
      tabs: surfaces.map((surface) => ({
        tabId: surface.tabId,
        worktreeId: 'folder-worker-host',
        title: 'Terminal',
        activeLeafId: surface.leafId,
        layout: null
      })),
      leaves: surfaces.map((surface) => ({
        tabId: surface.tabId,
        worktreeId: 'folder-worker-host',
        leafId: surface.leafId,
        paneRuntimeId: 1,
        ptyId: surface.ptyId
      }))
    })
  } else {
    vi.spyOn(h.runtime, 'getTerminalPaneKey').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(h.runtime, 'getLiveTerminalPaneKey').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(h.runtime, 'getPaneKeyForTerminalHandle').mockImplementation(
      (handle) => panes.get(handle) ?? null
    )
    vi.spyOn(h.runtime, 'getTerminalHandleForPaneKey').mockImplementation(
      (pane) => [...panes].find(([, value]) => value === pane)?.[0] ?? null
    )
    vi.spyOn(h.runtime, 'getTerminalWorktreeIdForHandle').mockImplementation((handle) =>
      panes.has(handle) ? 'folder-worker-host' : null
    )
    vi.spyOn(h.runtime, 'getTerminalProcessIncarnation').mockImplementation((handle) =>
      panes.has(handle) ? `process:${handle}` : null
    )
  }
  vi.spyOn(h.runtime, 'getOrchestrationDispatchAuthority').mockReturnValue(null)
  vi.spyOn(h.runtime, 'getOrchestrationFleetAgentStatusSnapshot').mockReturnValue([])
  const delivery = vi
    .spyOn(h.runtime, 'deliverPendingMessagesForHandle')
    .mockImplementation(() => {})
  const notify = vi.spyOn(h.runtime, 'notifyMessageArrived')
  vi.spyOn(console, 'log').mockImplementation(() => {})
  const receipts: { method: string; result: unknown }[] = []
  const client = new RuntimeClient('/tmp/crew-all-row-contract', 1000, null, null)
  vi.spyOn(client, 'call').mockImplementation(async (method: string, params: unknown) => {
    hostRef.current = ref.current
    const response = await h.dispatch(
      orchestrationRequest(method, z.record(z.string(), z.unknown()).parse(params), {
        evidence: readOrchestrationCompatibilityEvidence({
          ORCA_TERMINAL_HANDLE: process.env.ORCA_TERMINAL_HANDLE,
          ORCA_PANE_KEY: process.env.ORCA_PANE_KEY
        })
      })
    )
    if (!response.ok) {
      throw new RuntimeClientError(response.error.code, response.error.message)
    }
    receipts.push({ method, result: response.result })
    return { ...response, result: response.result, _meta: { runtimeId: h.runtime.getRuntimeId() } }
  })
  const command = async (from: string, name: string, entries: [string, string | boolean][]) => {
    vi.stubEnv('ORCA_AGENT_SESSION_ID', '')
    vi.stubEnv('ORCA_TERMINAL_HANDLE', from)
    vi.stubEnv('ORCA_PANE_KEY', panes.get(from) ?? '')
    await dispatch(['orchestration', name], {
      client,
      flags: new Map<string, string | boolean>([...entries, ['from', from]]),
      cwd: '/tmp',
      json: true
    })
  }
  const send = (from: string, to: string, subject: string) =>
    command(from, 'send', [
      ['to', to],
      ['subject', subject],
      ['body', 'hello']
    ])
  const mail = () => h.db.db.prepare('SELECT * FROM messages ORDER BY sequence').all()
  const effects = () =>
    structuredClone({ mail: mail(), delivery: delivery.mock.calls, notify: notify.mock.calls })
  return {
    ...h,
    panes,
    receipts,
    command,
    send,
    mail,
    effects,
    close: () => {
      getWorkerTerminalAutoReleaseScheduler(h.runtime).clear()
      h.close()
      hostRef.current = null
    }
  }
}
