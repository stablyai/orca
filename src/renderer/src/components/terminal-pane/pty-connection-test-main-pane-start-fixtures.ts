import { expect } from 'vitest'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import type { PaneResumeOutcome } from '../../../../shared/workspace-layout/workspace-layout-published'
import type { TerminalPaneResumeOutcome } from '@/store/terminals/terminal-state'
import type { MockTransport } from './pty-connection-test-pane-fixtures'
import type { layoutApplyTestTransport as answeringFallback } from '@/runtime/layout-apply-test-transport.test-fixture'

type ConnectOptions = {
  sessionId?: string
  attachOnlyView?: true
  command?: string
  resumeProviderSession?: unknown
}

/** Main owns start/resume; every window connect is attach-only without its own launch command. */
export async function expectWindowStartAskedMain(
  transport: MockTransport,
  paneKey: string,
  store?: ResumeRegistry
): Promise<void> {
  const layoutApplyTestTransport = await mainLayoutApplyTransport()
  await layoutApplyTestTransport.settle()
  expect(layoutApplyTestTransport.sentOfType('startPane')).toContainEqual(
    expect.objectContaining({ type: 'startPane', paneKey })
  )
  expectNoWindowStart(transport, store)
}

type ResumeRegistry = { registerAgentLaunchConfig: unknown }

/** Verify the window neither starts/resumes a terminal nor registers its own resume launch. */
export function expectNoWindowStart(transport: MockTransport, store?: ResumeRegistry): void {
  if (store) {
    expect(store.registerAgentLaunchConfig).not.toHaveBeenCalled()
  }
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the mock transport's connect takes one options argument.
  for (const [options] of transport.connect.mock.calls as [ConnectOptions | undefined][]) {
    expect(options?.command).toBeUndefined()
    expect(options?.resumeProviderSession).toBeUndefined()
    if (options?.sessionId) {
      expect(options.attachOnlyView).toBe(true)
    }
  }
}

type LayoutApplyTestTransport = typeof answeringFallback

/** Resolve the mocked layout-command transport dynamically across resetModules. */
export async function mainLayoutApplyTransport(): Promise<LayoutApplyTestTransport> {
  const { ANSWERING_TRANSPORT, layoutApplyTestTransport } =
    await import('@/runtime/layout-apply-test-transport.test-fixture')
  const client: object = await import('@/runtime/runtime-rpc-client')
  const answering = ANSWERING_TRANSPORT in client ? client[ANSWERING_TRANSPORT] : undefined
  return isLayoutApplyTestTransport(answering) ? answering : layoutApplyTestTransport
}

function isLayoutApplyTestTransport(value: unknown): value is LayoutApplyTestTransport {
  return typeof value === 'object' && value !== null && 'sentOfType' in value && 'reset' in value
}

/** Install before startPane: main’s frame binds the terminal, which answers the window’s attach. */
export async function mainStartsPaneAs(args: {
  ptyId: string
  bind: (ptyId: string) => void
  transport?: MockTransport
}): Promise<void> {
  const layoutApplyTestTransport = await mainLayoutApplyTransport()
  layoutApplyTestTransport.answerWith((command) => {
    if (command.type === 'startPane') {
      args.bind(args.ptyId)
      args.transport?.connect.mockImplementation(async (options: { sessionId?: string }) =>
        options.sessionId === args.ptyId ? { id: args.ptyId, isReattach: true } : undefined
      )
    }
    return { ok: true, result: {} }
  })
}

/** Cold reattach paints only: main owns resume, its record and outcome banner; the window registers or consumes none. */
export function expectWindowPaintsColdRestoreOnly(
  pane: { terminal: { write: { mock: { calls: unknown[][] } } } },
  transport: MockTransport,
  deps: { onShowSessionRestoredBanner: unknown },
  store: ResumeRegistry & { clearSleepingAgentSession: unknown },
  ptyId: string
): void {
  expect(transport.connect).toHaveBeenCalledWith(
    expect.objectContaining({ sessionId: ptyId, attachOnlyView: true })
  )
  expect(
    pane.terminal.write.mock.calls.some(
      ([data]) => typeof data === 'string' && data.endsWith('cold-payload')
    )
  ).toBe(true)
  expectNoWindowStart(transport, store)
  expect(transport.sendInput).not.toHaveBeenCalled()
  expect(deps.onShowSessionRestoredBanner).not.toHaveBeenCalled()
  expect(store.clearSleepingAgentSession).not.toHaveBeenCalled()
}

type LayoutsHolder = { terminalLayoutsByTabId?: Record<string, TerminalLayoutSnapshot> }

/** Main's frame binding one pane: writes the binding into the test store's layout. */
export function bindsPaneInStore(
  getState: () => LayoutsHolder,
  tabId: string,
  leafId: string
): (ptyId: string) => void {
  return (ptyId) => {
    const state = getState()
    const layout = state.terminalLayoutsByTabId?.[tabId] ?? {
      root: { type: 'leaf', leafId },
      activeLeafId: leafId,
      expandedLeafId: null
    }
    state.terminalLayoutsByTabId = {
      ...state.terminalLayoutsByTabId,
      [tabId]: { ...layout, ptyIdsByLeafId: { ...layout.ptyIdsByLeafId, [leafId]: ptyId } }
    }
  }
}

type ResumeOutcomesHolder = {
  terminalPaneResumeOutcomesByPaneKey?: Record<string, TerminalPaneResumeOutcome>
}

/** Main's frame saying its start of the pane resumed (or could not resume) the agent in `ptyId`. */
export function publishesResumeOutcomeInStore(
  getState: () => ResumeOutcomesHolder,
  paneKey: string,
  outcome: PaneResumeOutcome
): (ptyId: string) => void {
  return (ptyId) => {
    const state = getState()
    state.terminalPaneResumeOutcomesByPaneKey = {
      ...state.terminalPaneResumeOutcomesByPaneKey,
      [paneKey]: { ptyId, ptyGeneration: 1, outcome }
    }
  }
}
