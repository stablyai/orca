// @vitest-environment happy-dom

// Machine rows inside the dialog's checkbox-column list: one column of boxes, one Select all.

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { useAppStore } from '../store'
import { getDefaultSettings } from '../../../shared/constants'
import { getHostContextLabel } from '../../../shared/worktree/host-context-labels'
import { getHostDisplayLabelOverrides } from '../../../shared/host-setting-overrides'
import { buildSidebarHostOptions } from './sidebar/sidebar-host-options'
import { NativeChatResumeOnRestartModal } from './NativeChatResumeOnRestartModal'
import { TooltipProvider } from './ui/tooltip'
import type { ResumeCandidate, ResumeFailure } from './native-chat-resume-on-restart-grouping'
import {
  consumeNativeChatResumeOnRestartDialogRequest,
  requestNativeChatResumeOnRestartDialog
} from './native-chat-resume-on-restart-dialog'
import { readNativeChatRestartMachine } from './native-chat-resume-on-restart-store'
import { _resetNativeChatRestartOffer } from './native-chat-restart-offer-triggers'
import { pairedEnvironment } from './native-chat-restart-offer-test-support'
import { replaceRuntimeEnvironmentRevisions } from '@/runtime/runtime-environment-revision'
import { button, chatBox, namedBox } from './native-chat-resume-on-restart-modal.test-support'
import {
  machineDisclosure,
  machineRow,
  machineRowFixture as row,
  machineToggle
} from './native-chat-resume-machines.test-support'

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

type Listing = { sessions: ResumeCandidate[]; failed?: ResumeFailure[] }

const LOCAL = getHostContextLabel('local')
const SERVER_ROWS = [row('s1', 'own'), row('s2', 'other-device'), row('s3', 'automation')]

/** Reads this computer and each named server with the listing given for it. A server's resume
 *  never answers; this computer's does at once. */
async function stage(local: Listing, servers: Record<string, Listing>): Promise<void> {
  rpc.mockImplementation(async (target, method) => {
    if (method === 'agentSession.restartContinue') {
      return target.kind === 'local' ? { continued: [], ...local } : new Promise(() => {})
    }
    return target.kind === 'local' ? local : (servers[target.environmentId] ?? { sessions: [] })
  })
  await act(async () => {
    await readNativeChatRestartMachine({ kind: 'local' })
    for (const environmentId of Object.keys(servers)) {
      await readNativeChatRestartMachine({ kind: 'environment', environmentId })
    }
  })
}

async function open(focus: string | null): Promise<void> {
  await act(async () =>
    root.render(
      <TooltipProvider>
        <NativeChatResumeOnRestartModal />
      </TooltipProvider>
    )
  )
  await act(async () => requestNativeChatResumeOnRestartDialog(focus))
}

/** The grid row a checkbox heads: its first cell is the checkbox column. */
function rowOf(box: HTMLElement): HTMLElement {
  return box.parentElement!.parentElement!
}

function selectAllCount(): string | undefined {
  return namedBox('Select all chats').closest('label')?.querySelector('.tabular-nums')?.textContent
}

beforeEach(() => {
  rpc.mockReset()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
  useAppStore.setState({
    settings: { ...getDefaultSettings(''), experimentalNativeChat: false },
    runtimeEnvironments: [
      pairedEnvironment('studio', 'studio-mac'),
      pairedEnvironment('build', 'build-box')
    ]
  })
  container = document.createElement('div')
  document.body.append(container)
  root = createRoot(container)
})

afterEach(() => {
  replaceRuntimeEnvironmentRevisions([])
  act(() => root.unmount())
  container.remove()
  _resetNativeChatRestartOffer()
  consumeNativeChatResumeOnRestartDialogRequest()
  useAppStore.setState(useAppStore.getInitialState(), true)
})

it('puts each machine in the tree’s one checkbox column, its chats one level further in', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')

  expect(document.querySelectorAll('[aria-label="Select all chats"]')).toHaveLength(1)
  // Every checkbox opens its row; nesting is the indent after it and the tree's own levels.
  const level = (box: HTMLElement) => box.closest('[role="treeitem"]')?.getAttribute('aria-level')
  for (const box of document.querySelectorAll<HTMLElement>('[role="tree"] [role="checkbox"]')) {
    expect(box.closest('label')?.firstElementChild?.contains(box)).toBe(true)
  }
  expect(level(machineToggle('studio-mac'))).toBe('1')
  expect(level(namedBox('Select all chats in workspace-s1'))).toBe('2')
  expect(level(chatBox('s1'))).toBe('3')

  const order = [
    namedBox('Select all chats'),
    machineToggle(LOCAL),
    machineToggle('studio-mac'),
    namedBox('Select all chats in workspace-s1'),
    chatBox('s1'),
    namedBox('Select all chats in workspace-s2'),
    chatBox('s2'),
    namedBox('Select all chats in workspace-s3'),
    chatBox('s3')
  ]
  order[0]!.focus()
  for (const next of order.slice(1)) {
    await act(async () => {
      document.activeElement?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })
      )
    })
    expect(document.activeElement).toBe(next)
  }
})

// One tree lists every machine: a paired server is one machine node, never a node inside a row of
// this dialog's own. The tree's keys pass the rows' own dismiss controls by: they are not checkboxes.
it('shows a paired server as exactly one machine node, and its keys pass the rows’ dismiss', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  const named = [...document.querySelectorAll('[role="treeitem"]')].filter(
    (item) =>
      item.getAttribute('aria-level') === '1' &&
      item.querySelector('[role="checkbox"]')?.getAttribute('aria-label')?.includes('studio-mac')
  )
  expect(named).toHaveLength(1)
  expect(document.querySelectorAll('[aria-label="Select all chats on studio-mac"]')).toHaveLength(1)

  // Another device's chat has its own dismiss beside it; Down from that chat goes to the next box.
  const s2Row = chatBox('s2').closest('[role="treeitem"]')!
  expect(s2Row.querySelector('button[aria-label^="Dismiss"]')).not.toBeNull()
  const press = (target: Element, key: string) =>
    act(async () => {
      target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  chatBox('s2').focus()
  await press(chatBox('s2'), 'ArrowDown')
  expect(document.activeElement).toBe(namedBox('Select all chats in workspace-s3'))
  // From the tree's own Tab stop: Down enters at the first box, End at the last.
  const tree = document.querySelector<HTMLElement>('[role="tree"]')!
  tree.focus()
  await press(tree, 'ArrowDown')
  expect(document.activeElement).toBe(namedBox('Select all chats'))
  tree.focus()
  await press(tree, 'End')
  expect(document.activeElement).toBe(chatBox('s3'))
  // A pressed arrow hands focus to its machine's checkbox, beside the machine's subtitle.
  await act(async () => machineDisclosure('studio-mac').click())
  expect(document.activeElement).toBe(machineToggle('studio-mac'))
})

// A machine is a node of the tree: its row heads its workspaces, says why it stopped and when, and
// Left/Right on its checkbox close and open it as on any node.
it('heads each machine’s workspaces with its own row, opened and closed from its checkbox', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  const studio = machineRow('studio-mac')
  expect(studio.textContent).toContain('Installed an update · now')
  expect(
    studio.compareDocumentPosition(namedBox('Select all chats in workspace-s1')) &
      Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy()
  expect(machineRow(LOCAL).getAttribute('aria-expanded')).toBe('false')
  const key = (key: string) =>
    act(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }))
    })
  machineToggle(LOCAL).focus()
  await key('ArrowRight')
  expect(machineRow(LOCAL).getAttribute('aria-expanded')).toBe('true')
  expect(chatBox('l1')).toBeTruthy()
  await key('ArrowLeft')
  expect(machineRow(LOCAL).getAttribute('aria-expanded')).toBe('false')
})

// Two servers may hold the same session id: each row is its own machine's, ticked and resumed there.
it('keeps a chat of the same id on two servers apart, ticked and resumed on its own machine', async () => {
  await stage(
    { sessions: [] },
    { studio: { sessions: [row('s1', 'own')] }, build: { sessions: [row('s1', 'other-device')] } }
  )
  await open(null)
  // build-box starts open (nothing on it starts ticked); open studio-mac too.
  await act(async () => machineDisclosure('studio-mac').click())
  const boxes = [...document.querySelectorAll<HTMLElement>('[aria-label*="Prompt s1"]')]
  const machineOf = (box: HTMLElement) =>
    machineToggle('build-box').compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING &&
    !(machineToggle('studio-mac').compareDocumentPosition(box) & Node.DOCUMENT_POSITION_FOLLOWING)
      ? 'build'
      : 'studio'
  const onBuild = boxes.find((box) => machineOf(box) === 'build')!
  const onStudio = boxes.find((box) => machineOf(box) === 'studio')!
  expect([onBuild.getAttribute('aria-checked'), onStudio.getAttribute('aria-checked')]).toEqual([
    'false',
    'true'
  ])
  await act(async () => onBuild.click())
  expect([onBuild.getAttribute('aria-checked'), onStudio.getAttribute('aria-checked')]).toEqual([
    'true',
    'true'
  ])
  await act(async () => onStudio.click())
  await act(async () => button('Resume 1 chat').click())
  expect(
    rpc.mock.calls
      .filter((call) => call[1] === 'agentSession.restartContinue')
      .map((call) => call[0])
  ).toEqual([{ kind: 'environment', environmentId: 'build' }])
})

// A machine the user opened or closed stays that way when its next answer lands.
it('keeps a machine the user closed closed when its answer arrives again', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  expect(machineRow('studio-mac').getAttribute('aria-expanded')).toBe('true')
  await act(async () => machineDisclosure('studio-mac').click())
  await stage(
    { sessions: [row('l1', 'own')] },
    { studio: { sessions: [...SERVER_ROWS, row('s4', 'own')] } }
  )
  expect(machineRow('studio-mac').getAttribute('aria-expanded')).toBe('false')
  expect(machineRow('studio-mac').textContent).toContain('2 of 4')
})

// What the user opened or closed holds for the listing it was done in: a server re-paired, or gone
// and listed again, starts from its own defaults.
it.each([
  ['re-paired', 2],
  ['listed again under the same pairing', undefined]
] as const)(
  'opens a machine the user had closed by its default once it is %s',
  async (_, pairingRevision) => {
    replaceRuntimeEnvironmentRevisions([])
    await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
    await open('environment:studio')
    await act(async () => machineDisclosure('studio-mac').click())
    expect(machineRow('studio-mac').getAttribute('aria-expanded')).toBe('false')
    // The server's listing goes; this computer's keeps the dialog open.
    await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: [] } })
    expect(document.querySelectorAll('[aria-label="Select all chats on studio-mac"]')).toHaveLength(
      0
    )
    if (pairingRevision !== undefined) {
      replaceRuntimeEnvironmentRevisions([{ id: 'studio', createdAt: 1, pairingRevision }])
    }
    await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
    expect(machineRow('studio-mac').getAttribute('aria-expanded')).toBe('true')
    expect(chatBox('s1')).toBeTruthy()
  }
)

it('ticks and clears only its own machine’s chats from a machine’s tri-state box', async () => {
  await stage(
    { sessions: [row('l1', 'own'), row('l2', 'other-device')] },
    { studio: { sessions: SERVER_ROWS } }
  )
  await open(null)
  expect(machineToggle(LOCAL).getAttribute('aria-checked')).toBe('mixed')
  expect(machineToggle('studio-mac').getAttribute('aria-checked')).toBe('mixed')

  await act(async () => machineToggle('studio-mac').click())
  expect(machineToggle('studio-mac').getAttribute('aria-checked')).toBe('true')
  expect(machineToggle(LOCAL).getAttribute('aria-checked')).toBe('mixed')
  expect(button('Resume 4 chats')).toBeTruthy()

  await act(async () => machineToggle('studio-mac').click())
  expect(machineToggle('studio-mac').getAttribute('aria-checked')).toBe('false')
  expect(machineToggle(LOCAL).getAttribute('aria-checked')).toBe('mixed')
  expect(button('Resume 1 chat')).toBeTruthy()
})

// Another device's chat starts unticked but can be picked, so Select all counts and ticks it; a
// failure no retry can fix cannot be picked at all, so it counts nowhere.
it('counts one Select all across machines, others’ chats included, unfixable failures not', async () => {
  const unfixable = {
    ...row('s4', 'own'),
    failedAt: 1_800_000_060_000,
    outcome: 'refused' as const,
    reason: 'agent_session_restart_work_superseded',
    retryable: false
  }
  await stage(
    { sessions: [row('l1', 'own')] },
    { studio: { sessions: [row('s1', 'own'), row('s2', 'other-device')], failed: [unfixable] } }
  )
  await open('environment:studio')
  const selectAll = namedBox('Select all chats')
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  expect(selectAllCount()).toBe('2 of 3 selected')

  await act(async () => selectAll.click())
  expect(selectAll.getAttribute('aria-checked')).toBe('true')
  expect(selectAllCount()).toBe('3 of 3 selected')
  expect(chatBox('s2').getAttribute('aria-checked')).toBe('true')
  expect(chatBox('s4').getAttribute('aria-checked')).toBe('false')
  expect(button('Resume 3 chats')).toBeTruthy()

  await act(async () => selectAll.click())
  expect(selectAllCount()).toBe('0 of 3 selected')
  expect(button('Resume 0 chats').disabled).toBe(true)
})

// A machine mid-resume is locked; its chats show the run, not a choice Select all can change.
it('leaves a machine whose resume is running out of Select all', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  await act(async () => button('Resume 2 chats').click())
  await open('environment:studio')
  expect(machineToggle('studio-mac').hasAttribute('disabled')).toBe(true)
  expect(selectAllCount()).toBe('1 of 1 selected')
  await act(async () => namedBox('Select all chats').click())
  expect(selectAllCount()).toBe('0 of 1 selected')
  // The running chat shows where it stands in its checkbox's place.
  expect(
    document.querySelector('[role="img"][aria-label="Prompt s1: Waiting to start · 0s"]')
  ).not.toBeNull()
  expect(button('Resuming…').disabled).toBe(true)
})

// With every machine mid-resume there is nothing to choose; Select all shows the run instead.
it('shows the run in Select all while every machine is resuming', async () => {
  await stage(
    { sessions: [] },
    { studio: { sessions: SERVER_ROWS }, build: { sessions: [row('b1', 'own')] } }
  )
  await open(null)
  await act(async () => button('Resume 2 chats').click())
  await open(null)
  const selectAll = namedBox('Select all chats')
  expect(selectAll.hasAttribute('disabled')).toBe(true)
  expect(selectAll.getAttribute('aria-checked')).toBe('mixed')
  expect(selectAllCount()).toBe('2 of 4 selected')
})

// The machine row names the server; a chip saying the same on every workspace under it would only
// repeat it, so a paired server's workspaces carry none.
it('names a paired server once, on its machine row, not again on each workspace', async () => {
  await stage({ sessions: [row('l1', 'own')] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  for (const sessionId of ['s1', 's2', 's3']) {
    const workspace = rowOf(namedBox(`Select all chats in workspace-${sessionId}`))
    expect(workspace.textContent).not.toContain('studio')
  }
})

// A machine is named from the sidebar's host names, a rename included: this computer, a server,
// and this computer's SSH host, which carries the SSH chip. No workspace repeats a machine's name.
it('names each machine as the sidebar does, a rename included, and an SSH host with its chip', async () => {
  useAppStore.setState({
    settings: {
      ...getDefaultSettings(''),
      experimentalNativeChat: false,
      hostSettingOverrides: {
        local: { displayLabel: 'Desk' },
        'runtime:studio': { displayLabel: 'Studio' }
      }
    },
    sshTargetLabels: new Map([['devbox-1', 'devbox']])
  })
  const onSsh = { ...row('l2', 'own'), executionHostId: 'ssh:devbox-1' as const }
  await stage({ sessions: [row('l1', 'own'), onSsh] }, { studio: { sessions: SERVER_ROWS } })
  await open('environment:studio')
  // The labels the sidebar's own host sections are built from.
  const state = useAppStore.getState()
  const sidebar = new Map(
    buildSidebarHostOptions({
      repos: state.repos,
      sshTargetLabels: state.sshTargetLabels,
      sshConnectionStates: state.sshConnectionStates,
      settings: state.settings,
      runtimeEnvironments: state.runtimeEnvironments,
      runtimeStatusByEnvironmentId: state.runtimeStatusByEnvironmentId,
      hostLabelOverrides: getHostDisplayLabelOverrides(state.settings)
    }).map((host) => [host.id, host.label])
  )
  expect([sidebar.get('local'), sidebar.get('runtime:studio')]).toEqual(['Desk', 'Studio'])
  expect(machineToggle('Desk')).toBeTruthy()
  expect(machineToggle('Studio')).toBeTruthy()
  expect(machineRow('devbox').textContent).toContain('SSH')
  expect(machineRow('Studio').textContent).not.toContain('SSH')
  await act(async () => machineDisclosure('devbox').click())
  const workspaceRow = (name: string) =>
    namedBox(`Select all chats in ${name}`).closest('[role="treeitem"]')?.textContent ?? ''
  expect(workspaceRow('workspace-s1')).not.toContain('Studio')
})
