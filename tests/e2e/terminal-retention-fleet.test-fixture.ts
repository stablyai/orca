import { hostWorktreeTarget } from '../../src/shared/worktree/host-qualified-identity'
import { buildAutomationWorkspaceProvenance } from '../../src/shared/automation-workspace-provenance'
import { expect, vi } from 'vitest'
import { OrcaRuntimeService } from '../../src/main/runtime/orca-runtime'
import {
  AUTOMATION_AGENT_CALLER,
  automationRunOperationId
} from '../../src/main/automations/automation-run-operation'
import { rpcCallerOperationKey } from '../../src/main/runtime/rpc/rpc-caller-identity'
import { readAutomationRunReceipt } from '../../src/main/automations/automation-run-receipt'
import type { AutomationRun } from '../../src/shared/automations-types'
import { setup, catalog, retentionNow } from './terminal-reuse-retention.test-fixture'
export async function fleet(population: number, sameAutomation = false, ownWorkspaces = false) {
  catalog.paths = [
    '/tmp/worktree-a',
    ...Array.from({ length: population }, (_, n) => `/tmp/worktree-${n}`)
  ]
  const h = await setup(true)
  let next = 0
  const originalControllerWrites: string[] = []
  const host = new OrcaRuntimeService(h.store)
  host.setPtyController({
    spawn: async () => ({ id: `mutation-pty-${next++}` }),
    write: (id, data) => {
      originalControllerWrites.push(data)
      host.onPtyData(id, '› draft\n\x1b[?25h', Date.now())
      return true
    },
    kill: () => true,
    getForegroundProcess: async () => 'codex'
  })
  const paneHandle = new Map<string, string>()
  h.external.showTerminalWorkspaceLaunchScope.mockImplementation(
    host.showTerminalWorkspaceLaunchScope.bind(host)
  )
  h.external.createTerminal.mockImplementation(async (selector, options) => {
    const created = await host.createTerminal(selector, options)
    const pane = host.getTerminalPaneKey(created.handle)!
    paneHandle.set(pane, created.handle)
    const binding = host.getTerminalPromptRequestBinding(created.handle)
    host.terminalRunFacts.recordSpawnCommit({
      id: binding.ptyId,
      incarnationId: binding.processIncarnation
    })
    return { handle: created.handle, paneKey: pane }
  })
  h.external.showTerminal.mockImplementation(host.showTerminal.bind(host))
  h.external.getTerminalHandleForPaneKey.mockImplementation((pane) => paneHandle.get(pane) ?? null)
  Object.assign(h.runtime, {
    getTerminalWorktreeIdForHandle: host.getTerminalWorktreeIdForHandle.bind(host),
    getTerminalPaneKey: host.getTerminalPaneKey.bind(host),
    getTerminalPtyIdForHandle: (handle: string) =>
      h.stopped.includes(handle) ? null : host.getTerminalPtyIdForHandle(handle),
    getTerminalPromptRequestBinding: host.getTerminalPromptRequestBinding.bind(host),
    getTerminalProcessIncarnation: host.getTerminalProcessIncarnation.bind(host),
    readTerminalClientUse: host.readTerminalClientUse.bind(host),
    getAgentStatusRowsForPane: (pane: string) => [
      { state: 'done', connectionId: null, terminalHandle: paneHandle.get(pane) }
    ],
    readObservedAgentStatusPaneIdentityFn: (pane: string) => ({
      kind: 'observed',
      terminalHandle: paneHandle.get(pane),
      processIncarnation: host.getTerminalProcessIncarnation(paneHandle.get(pane)!),
      dispatchId: null
    }),
    readLaunchedAgentForeground: host.readLaunchedAgentForeground.bind(host),
    subscribeToTerminalData: host.subscribeToTerminalData.bind(host),
    sendTerminalAgentPrompt: host.sendTerminalAgentPrompt.bind(host)
  })
  h.control.shell = true
  const seeds: AutomationRun[] = []
  const base = Date.now()
  let siblingAutomation = h.automation
  for (let n = 0; n < population; n++) {
    const path = ownWorkspaces || sameAutomation ? `/tmp/worktree-${n}` : '/tmp/worktree-a'
    if (!catalog.paths.includes(path)) {
      catalog.paths.push(path)
    }
    if (sameAutomation) {
      if (n % 13 === 0) {
        siblingAutomation = h.store.createAutomation({
          ...h.automation,
          name: `Sibling group ${n}`
        })
      }
      h.store.updateAutomation(siblingAutomation.id, { workspaceId: `r1::${path}` })
    }
    const automation = sameAutomation
      ? h.store.listAutomations().find((a) => a.id === siblingAutomation.id)!
      : h.store.createAutomation({
          ...h.automation,
          name: `Creator ${n}`,
          workspaceId: `r1::${path}`
        })
    vi.spyOn(Date, 'now').mockReturnValue(base + n * 1000)
    const seed = await h.service.runNow(automation.id)
    if (ownWorkspaces) {
      h.store.setWorktreeMeta(hostWorktreeTarget({ id: seed.workspaceId!, hostId: 'local' }), {
        automationProvenance: buildAutomationWorkspaceProvenance(automation, seed, {
          executionHostId: 'local'
        })
      })
    }
    expect(readAutomationRunReceipt(h.records, seed)).toMatchObject({
      kind: 'terminal',
      accepted: true
    })
    expect(
      h.records.getOperationRow(
        rpcCallerOperationKey(AUTOMATION_AGENT_CALLER),
        automationRunOperationId(seed, 'fresh-launch')
      )?.outcome.status
    ).toBe('succeeded')
    seeds.push(seed)
  }
  vi.spyOn(Date, 'now').mockImplementation(retentionNow)
  expect(h.external.createTerminal).toHaveBeenCalledTimes(population)
  return { ...h, seeds, host, paneHandle, originalControllerWrites }
}
