// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { NativeChatResumeStatusSegment } from './status-bar/NativeChatResumeStatusSegment'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { _resetNativeChatRestartOffer } from './native-chat-restart-offer-triggers'

// The dialog's own layout and focus, apart from what its actions do.

const rpc = vi.hoisted(() => vi.fn())
vi.mock('@/runtime/structured-agent-session-client', () => ({
  callStructuredAgentSession: rpc,
  pairedRestartOffersSupport: async () => 'supported',
  // A failed row opens the status feed; these cases never drive it.
  subscribeStructuredAgentSessionStatus: () => new Promise(() => {})
}))
vi.mock('sonner', () => ({ toast: Object.assign(vi.fn(), { dismiss: vi.fn() }) }))

globalThis.IS_REACT_ACT_ENVIRONMENT = true
let root: Root
let container: HTMLDivElement
const offered: ResumeCandidate[] = ['a', 'b'].map((sessionId) => ({
  sessionId,
  workspaceId: 'workspace',
  agent: 'codex',
  trigger: 'quit',
  latestPrompt: `Prompt ${sessionId}`,
  recordedAt: 1_800_000_000_000,
  executionHostId: 'local',
  workspaceKind: 'git-worktree',
  origin: 'own'
}))

/** A chat the host acted on and could not carry on, as it reports it. */
function failure(sessionId: string) {
  const candidate = offered.find((entry) => entry.sessionId === sessionId)!
  return {
    ...candidate,
    failedAt: candidate.recordedAt + 60_000,
    outcome: 'refused',
    reason: 'agent_session_restart_work_superseded'
  }
}

/** Outcome rows carry tooltips, so every mount needs the provider the app shell supplies. */
async function mount(node: React.ReactNode): Promise<void> {
  await act(async () => root.render(<TooltipProvider>{node}</TooltipProvider>))
}

function button(text: string): HTMLButtonElement {
  const found = [...document.querySelectorAll('button')].find(
    (entry) => entry.textContent?.trim() === text || entry.getAttribute('aria-label') === text
  )
  if (!found) {
    throw new Error(`Missing button: ${text}`)
  }
  return found
}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNativeChat: true }
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  useAppStore.setState(useAppStore.getInitialState(), true)
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
})

// Left to the dialog, focus lands on the scrollable list and draws a ring around it.
it('opens with focus on the resume action', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  expect(document.activeElement?.textContent?.trim()).toBe('Resume 2 chats')
})

it('uses the sidebar surface without a border around the resume list', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  const list = document.querySelector('[aria-label="Chats that would be resumed"]')
  expect(list).not.toBeNull()
  expect(list?.classList.contains('bg-worktree-sidebar')).toBe(true)
  expect(list?.classList.contains('border')).toBe(false)
})

it('keeps initial focus inside the dialog with no resumable chats', async () => {
  rpc.mockResolvedValue({ sessions: [], failed: [failure('b')] })
  await mount(<NativeChatResumeOnRestartModal />)
  await act(async () => requestNativeChatResumeOnRestartDialog())
  const dialog = document.querySelector('[role="dialog"]')
  expect(button('Resume 0 chats').disabled).toBe(true)
  expect(dialog).not.toBeNull()
  expect(dialog?.contains(document.activeElement)).toBe(true)
})

it('keeps initial focus inside the dialog when reopened during resume', async () => {
  const continued = Promise.withResolvers<unknown>()
  rpc.mockImplementation((_target, method) =>
    method === 'agentSession.restartResumable'
      ? Promise.resolve({ sessions: offered })
      : continued.promise
  )
  await mount(
    <>
      <NativeChatResumeOnRestartModal />
      <NativeChatResumeStatusSegment iconOnly={false} />
    </>
  )
  await act(async () => button('Resume 2 chats').click())
  const opener = button('Resuming chats 0/2')
  await act(async () => {
    opener.focus()
    opener.click()
  })
  const dialog = document.querySelector('[role="dialog"]')
  expect(button('Resuming…').disabled).toBe(true)
  expect(dialog).not.toBeNull()
  expect(dialog?.contains(document.activeElement)).toBe(true)
  await act(async () => continued.resolve({ sessions: [], failed: [], resumed: [], continued: [] }))
})

// One primary action and one way out of it; the body copy carries the transparency.
it('offers exactly Dismiss all and the resume action', async () => {
  rpc.mockResolvedValue({ sessions: offered })
  await mount(<NativeChatResumeOnRestartModal />)
  // Checkboxes and tree arrows are buttons too; the controls are what is left after them.
  const controls = document.querySelectorAll(
    '[role="dialog"] button:not([role="checkbox"]):not([aria-expanded])'
  )
  expect([...controls].map((entry) => entry.textContent?.trim())).toEqual([
    'Dismiss all',
    'Resume 2 chats',
    'Close'
  ])
})
