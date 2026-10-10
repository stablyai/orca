// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { TooltipProvider } from './ui/tooltip'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  getNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import {
  forgetNativeChatRestartMachine,
  getNativeChatRestartOffers,
  readNativeChatRestartMachine
} from './native-chat-resume-on-restart-store'
import { getNativeChatRestartRuns } from './native-chat-restart-runs'
import { continueNativeChatRestartOffers } from './native-chat-restart-offer-actions'
import { reopenNativeChatRestartOffer } from './native-chat-restart-offer-reopen'
import { _resetNativeChatRestartOffer } from './native-chat-restart-offer-triggers'
import { pairedEnvironment } from './native-chat-restart-offer-test-support'
import { machineRowFixture as row } from './native-chat-resume-machines.test-support'

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  pairedRestartOffersSupport: async () => 'supported',
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement

const STUDIO = { kind: 'environment', environmentId: 'studio' } as const
const LOCAL = { kind: 'local' } as const

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNativeChat: false },
    runtimeEnvironments: [pairedEnvironment('studio', 'studio-mac')]
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
})

// Unpairing a server whose finished run is all the open dialog shows leaves nothing to draw, so
// the request goes too: a later read must never pop the dialog up by itself.
it('retires the dialog request when the only run it shows belongs to a server that is unpaired', async () => {
  let localRows: unknown[] = []
  rpc.mockImplementation(async (target, method, params) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: target.kind === 'local' ? localRows : [row('s1', 'own')], failed: [] }
    }
    if (method === 'agentSession.restartContinue') {
      return {
        sessions: [],
        failed: [],
        continued: params.sessionIds.map((sessionId: string) => ({
          sessionId,
          outcome: 'continued'
        }))
      }
    }
    return {}
  })
  await act(async () =>
    root.render(
      <TooltipProvider>
        <NativeChatResumeOnRestartModal />
      </TooltipProvider>
    )
  )
  await act(async () => {
    await readNativeChatRestartMachine(STUDIO)
    await continueNativeChatRestartOffers([{ machine: 'environment:studio', sessionIds: ['s1'] }])
  })
  expect(getNativeChatRestartOffers().size).toBe(0)
  expect(getNativeChatRestartRuns().size).toBe(1)
  // The success toast's Show (or the user reopening) opens the finished run.
  await act(async () => requestNativeChatResumeOnRestartDialog('environment:studio'))
  expect(document.body.textContent).toContain('Resumed 1 of 1 chat')
  // Server unpaired / re-paired / contact revoked while the dialog is up.
  await act(async () => forgetNativeChatRestartMachine('environment:studio'))
  expect(getNativeChatRestartRuns().size).toBe(0)
  expect(document.body.textContent).not.toContain('Resumed 1 of 1 chat')
  expect(getNativeChatResumeOnRestartDialogRequest()).toBeNull()
  localRows = [row('l1', 'own')]
  await act(async () => {
    await readNativeChatRestartMachine(LOCAL)
  })
  expect(document.querySelector('[role="dialog"]')).toBeNull()
})

// A new resume retires an earlier resume's finished run, so the dialog and the status bar count the
// same chats.
it('counts one resume in the dialog and the status bar alike, not an earlier finished one', async () => {
  rpc.mockImplementation(async (target, method, params) => {
    if (method === 'agentSession.restartResumable') {
      return {
        sessions:
          target.kind === 'local' ? [row('l1', 'own'), row('l2', 'own')] : [row('s1', 'own')],
        failed: []
      }
    }
    if (method === 'agentSession.restartContinue') {
      if (target.kind === 'environment') {
        return new Promise(() => {})
      }
      return {
        sessions: [],
        failed: [],
        continued: params.sessionIds.map((sessionId: string) => ({
          sessionId,
          outcome: 'continued'
        }))
      }
    }
    return {}
  })
  await act(async () =>
    root.render(
      <TooltipProvider>
        <NativeChatResumeStatusSegment iconOnly={false} />
        <NativeChatResumeOnRestartModal />
      </TooltipProvider>
    )
  )
  await act(async () => {
    await readNativeChatRestartMachine(LOCAL)
    await readNativeChatRestartMachine(STUDIO)
    await continueNativeChatRestartOffers([{ machine: 'local', sessionIds: ['l1', 'l2'] }])
    void continueNativeChatRestartOffers([{ machine: 'environment:studio', sessionIds: ['s1'] }])
  })
  await act(async () => requestNativeChatResumeOnRestartDialog(null))
  const text = document.body.textContent ?? ''
  expect(document.querySelector('[role="dialog"] h2')?.textContent).toContain('Resuming 1 chat')
  expect(text).toContain('0 of 1 done')
  expect(text).toContain('Resuming chats 0/1')
})

// Only the resuming machine's re-read is skipped; another machine is read before the dialog opens.
it('re-reads a machine on reopen while another machine is mid-resume', async () => {
  let localRows = [row('l1', 'own')]
  rpc.mockImplementation(async (target, method) => {
    if (method === 'agentSession.restartResumable') {
      return { sessions: target.kind === 'local' ? localRows : [row('s1', 'own')], failed: [] }
    }
    if (method === 'agentSession.restartContinue') {
      return new Promise(() => {})
    }
    return {}
  })
  await act(async () => {
    await readNativeChatRestartMachine(LOCAL)
    await readNativeChatRestartMachine(STUDIO)
    void continueNativeChatRestartOffers([{ machine: 'environment:studio', sessionIds: ['s1'] }])
  })
  localRows = []
  const before = rpc.mock.calls.filter((call) => call[1] === 'agentSession.restartResumable').length
  await act(async () => {
    await reopenNativeChatRestartOffer(['local'])
  })
  const after = rpc.mock.calls.filter((call) => call[1] === 'agentSession.restartResumable').length
  expect(after - before).toBe(1)
  expect(getNativeChatRestartOffers().has('local')).toBe(false)
})
