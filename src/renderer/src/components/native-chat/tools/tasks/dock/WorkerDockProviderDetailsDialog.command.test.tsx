// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { RuntimeClientTarget } from '../../../../../../../shared/remote-runtime/host-catalog/runtime-client-target'
import type { StructuredSessionBackgroundTasksView } from '../../../../../../../shared/agent-session/view/structured-session-background-tasks-view'
import type { AgentChildWorkView } from '../../../../../../../shared/agent-status/child-work/agent-status-child-work-view'
import type { AgentSessionSubscribeEvent } from '../../../../../../../shared/agent-session/agent-session-wire'
import {
  createCommandDetailAuthority,
  type CommandDetailAuthority
} from '../../../../../../../shared/agent-session/view/live-read/command-detail-authority'
import {
  getOrCreateStructuredReadOwner,
  retireStructuredAgentSessionReadOwner,
  structuredReadOwnerKey
} from '../../../session/structured/read/structured-agent-session-read-owner-registry'
import { NativeChatStructuredSessionStatus } from '../NativeChatStructuredSessionStatus'

const hoisted = vi.hoisted(() => ({
  rpc: vi.fn<
    (target: unknown, method: string, params: unknown, options?: unknown) => Promise<unknown>
  >(),
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  crew: null as unknown
}))
vi.mock('@/runtime/rpc/calls/runtime-rpc-call', () => ({ callRuntimeRpc: hoisted.rpc }))
vi.mock('../../../worker-approvals/native-chat-worker-approval-feed', () => ({
  useNativeChatPinnedWorkerApprovals: () => []
}))
vi.mock('./worker-dock-feed', () => ({
  useWorkerDockFeed: () => ({
    party: 'party-synthetic',
    available: true,
    rows: new Map(),
    snapshot: { identities: [] },
    loadWindow: async () => {},
    readLosses: () => 0
  })
}))
vi.mock('../../../../orchestration-crew/use-native-chat-crew', async (original) => ({
  ...(await original<object>()),
  useNativeChatCrew: () => hoisted.crew
}))
vi.mock('../NativeChatCrewBackgroundTasksStatus', () => ({
  NativeChatCrewBackgroundTasksStatus: () => <div>crew strip</div>
}))

const SESSION = 'session-synthetic'
const LOCAL: RuntimeClientTarget = { kind: 'local' }
const TUPLE = { childWorkId: 'child-1', invocationId: 'run-1', generation: 1 }
const PREVIEW =
  "/fixture/bin/bash -lc 'fixture-build --target sample && fixture-check --suite smoke …"
const EXACT =
  'fixture-build --target sample && fixture-check --suite smoke\n  && fixture-pack "a b"'

const view: AgentChildWorkView = {
  id: TUPLE.childWorkId,
  providerId: 'codex-command:primary:call-1',
  kind: 'command',
  description: PREVIEW,
  state: 'working',
  membership: 'live',
  firstObservedAt: 1,
  observedAt: 1,
  stoppable: true,
  invocation: { invocationId: TUPLE.invocationId, generation: TUPLE.generation }
}

const tasks: StructuredSessionBackgroundTasksView = {
  show: true,
  isMonitoring: true,
  tasks: [],
  settledTasks: [],
  children: [view],
  supportsStop: true,
  offersStopAll: false,
  incomplete: false
}

let authority: CommandDetailAuthority
let scope: { transport: object; generation: number }
const writes: string[] = []

function frame(fence: number, available = true): AgentSessionSubscribeEvent {
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  return {
    type: 'batch',
    sessionId: SESSION,
    fence,
    batch: { cursor: { epoch: 'e', sequence: 2 }, items: [], removedItemIds: [], submissions: [] },
    backgroundTasks: {
      state: 'monitoring',
      children: [view],
      ...(available ? { commandDetailsAvailable: [TUPLE] } : {})
    }
  } as AgentSessionSubscribeEvent
}

function credit(): void {
  scope = { transport: {}, generation: 1 }
  authority.invalidate(scope)
  authority.seed(scope, { epoch: 'e', sequence: 2 })
  authority.observe(scope, frame(3))
}

function renderStrip() {
  // A fresh element each time: React skips a rerender of the identical element object.
  const view = () => (
    <TooltipProvider>
      <NativeChatStructuredSessionStatus
        sessionId={SESSION}
        target={LOCAL}
        paneKey="pane-synthetic"
        isVisible
        backgroundTasks={tasks}
        stop={{ stoppingTaskIds: new Set(), stoppingAll: false, onStop: vi.fn() }}
      />
    </TooltipProvider>
  )
  const rendered = render(view())
  fireEvent.click(screen.getByRole('button', { expanded: false }))
  return { ...rendered, again: () => rendered.rerender(view()) }
}

async function openRow() {
  const row = screen
    .getAllByRole('button', { name: /fixture-build/ })
    .find((button) => !button.hasAttribute('data-worker-dock-pill'))!
  fireEvent.click(row)
  // The dialog is lazy-loaded; its first import can take longer than the default second.
  return screen.findByRole('dialog', {}, { timeout: 10_000 })
}

beforeEach(() => {
  authority = createCommandDetailAuthority()
  getOrCreateStructuredReadOwner(
    structuredReadOwnerKey(SESSION, LOCAL),
    () =>
      // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
      ({
        commandDetails: authority
      }) as never
  )
  hoisted.crew = null
  hoisted.rpc.mockReset()
  hoisted.rpc.mockImplementation(async (_target, method) =>
    method === 'agentSession.backgroundCommand' ? { command: EXACT } : { ok: false }
  )
  writes.length = 0
  // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: test double; supplies only the fields this path reads
  ;(window as unknown as { api: unknown }).api = {
    ui: { writeClipboardText: vi.fn(async (text: string) => void writes.push(text)) }
  }
})
afterEach(() => {
  cleanup()
  retireStructuredAgentSessionReadOwner(SESSION, LOCAL)
})

describe('Worker Dock command dialog', () => {
  it('shows the exact command with Copy, and copies its bytes unchanged (no CRLF)', async () => {
    credit()
    renderStrip()
    const dialog = await openRow()
    const copy = await screen.findByRole('button', { name: 'Copy command' })
    expect(dialog).toHaveTextContent('fixture-pack "a b"')
    expect(dialog.querySelector('pre')?.textContent).toBe(EXACT)
    const reads = hoisted.rpc.mock.calls.filter(
      ([, method]) => method === 'agentSession.backgroundCommand'
    )
    expect(reads).toHaveLength(1)
    expect(reads[0]![2]).toEqual({
      sessionId: SESSION,
      childWorkId: TUPLE.childWorkId,
      invocation: { invocationId: TUPLE.invocationId, generation: TUPLE.generation }
    })
    fireEvent.click(copy)
    await waitFor(() => expect(writes).toEqual([EXACT]))
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument()
  })

  it('without credit shows the preview with its ellipsis, no Copy and no read', async () => {
    renderStrip()
    const dialog = await openRow()
    expect(dialog.querySelector('pre')?.textContent).toBe(PREVIEW)
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
    expect(screen.queryByText(/preview/i)).toBeNull()
    expect(hoisted.rpc).not.toHaveBeenCalledWith(
      expect.anything(),
      'agentSession.backgroundCommand',
      expect.anything(),
      expect.anything()
    )
  })

  it('a loss before React commits withdraws Copy, and a held click writes nothing', async () => {
    credit()
    renderStrip()
    await openRow()
    const copy = await screen.findByRole('button', { name: 'Copy command' })
    // The authority-changing frame arrives at ingress; the button is still on screen.
    authority.observe(scope, frame(4))
    fireEvent.click(copy)
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull())
    expect(writes).toEqual([])
    expect(screen.getByRole('dialog').querySelector('pre')?.textContent).toBe(PREVIEW)
  })

  it('a late reply after the opening was lost is discarded', async () => {
    credit()
    let reply: (value: unknown) => void = () => {}
    hoisted.rpc.mockImplementation((_target, method) =>
      method === 'agentSession.backgroundCommand'
        ? new Promise((resolve) => (reply = resolve))
        : Promise.resolve({ ok: false })
    )
    renderStrip()
    await openRow()
    await waitFor(() =>
      expect(hoisted.rpc).toHaveBeenCalledWith(
        expect.anything(),
        'agentSession.backgroundCommand',
        expect.anything(),
        expect.anything()
      )
    )
    authority.invalidate(null)
    await act(async () => reply({ command: EXACT }))
    expect(screen.queryByRole('button', { name: 'Copy command' })).toBeNull()
    expect(screen.getByRole('dialog').querySelector('pre')?.textContent).toBe(PREVIEW)
  })

  it('after a crew comes and goes it reappears on its own, focused on Close, with a fresh read', async () => {
    credit()
    const strip = renderStrip()
    await openRow()
    await screen.findByRole('button', { name: 'Copy command' })
    hoisted.crew = { summary: { status: 'ok', agents: 1 }, rows: [] }
    strip.again()
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    hoisted.crew = null
    strip.again()
    const dialog = await screen.findByRole('dialog')
    await waitFor(() =>
      expect(document.activeElement).toBe(dialog.querySelector('[data-slot="dialog-close"]'))
    )
    await screen.findByRole('button', { name: 'Copy command' })
    const reads = hoisted.rpc.mock.calls.filter(
      ([, method]) => method === 'agentSession.backgroundCommand'
    )
    expect(reads).toHaveLength(2)
  })
})
