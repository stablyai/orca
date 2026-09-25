/**
 * @vitest-environment happy-dom
 */
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ForkableAgentSession } from '@/lib/worktree-agent-fork-sessions'
import type { GitStatusEntry, GitStatusResult } from '../../../../shared/git-status-types'
import AgentSessionForkDialog from './AgentSessionForkDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const HEAD_OID = 'a'.repeat(40)

const mocks = vi.hoisted(() => ({
  runAgentSessionFork: vi.fn(),
  copyTranscriptPrompt: vi.fn(),
  getRuntimeGitStatus: vi.fn(),
  isWorkingTreeCarrySupported: vi.fn(),
  listForkableAgentSessions: vi.fn(),
  toastWarning: vi.fn(),
  toastMessage: vi.fn(),
  toastError: vi.fn()
}))

const sourceWorktree = {
  id: 'repo::wt',
  repoId: 'repo',
  displayName: 'Fix auth',
  branch: 'refs/heads/feature/auth',
  path: '/repos/wt'
}

const settings = { activeRuntimeEnvironmentId: null }

const initialModalData: Record<string, unknown> = {}

const state = {
  activeModal: 'agent-session-fork',
  modalData: initialModalData,
  closeModal: vi.fn(),
  agentStatusByPaneKey: {},
  retainedAgentsByPaneKey: {},
  sleepingAgentSessionsByPaneKey: {},
  agentLaunchConfigByPaneKey: {},
  repos: [{ id: 'repo', connectionId: 'ssh-1' }],
  settings,
  getKnownWorktreeById: (id: string) => (id === sourceWorktree.id ? sourceWorktree : undefined)
}

vi.mock('@/store', () => ({
  useAppStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
    getState: () => state
  })
}))

vi.mock('@/store/selectors', () => ({
  useRepoMap: () => new Map(),
  useWorktreesForRepo: () => []
}))

vi.mock('@/store/repos/owner-routing', () => ({
  settingsForRepoOwner: () => settings
}))

vi.mock('@/i18n/i18n', () => ({
  translate: (_key: string, fallback: string, options?: Record<string, unknown>) =>
    fallback.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? '')),
  i18n: { language: 'en', on: () => {}, off: () => {} }
}))

vi.mock('sonner', () => ({
  toast: {
    warning: mocks.toastWarning,
    message: mocks.toastMessage,
    error: mocks.toastError
  }
}))

vi.mock('@/runtime/runtime-git-status-client', () => ({
  getRuntimeGitStatus: mocks.getRuntimeGitStatus
}))

vi.mock('@/runtime/runtime-git-working-tree-carry-client', () => ({
  isWorkingTreeCarrySupported: mocks.isWorkingTreeCarrySupported
}))

vi.mock('@/lib/agent-session-fork-flow', () => ({
  runAgentSessionFork: mocks.runAgentSessionFork,
  copyTranscriptPrompt: mocks.copyTranscriptPrompt
}))

vi.mock('@/lib/worktree-agent-fork-sessions', () => ({
  listForkableAgentSessions: mocks.listForkableAgentSessions
}))

vi.mock('@/components/repo/CreateFromPicker', () => ({
  CreateFromPicker: (props: { onValueChange: (value: string) => void }) => (
    <button
      type="button"
      data-testid="create-from-picker"
      onClick={() => props.onValueChange('main')}
    >
      pick base
    </button>
  )
}))

function session(id: string, overrides: Partial<ForkableAgentSession> = {}): ForkableAgentSession {
  return {
    providerSessionId: id,
    paneKey: `tab-${id}:pane-1`,
    agent: 'claude',
    providerSession: { key: 'session_id', id },
    launchConfig: null,
    title: `Session ${id}`,
    lastActiveAt: Date.now() - 5 * 60_000,
    live: true,
    ...overrides
  }
}

function entry(path: string, area: GitStatusEntry['area']): GitStatusEntry {
  return { path, area, status: area === 'untracked' ? 'untracked' : 'modified' }
}

function statusWith(entries: GitStatusEntry[]): GitStatusResult {
  return { entries, conflictOperation: 'unknown', head: HEAD_OID }
}

const DIRTY_ENTRIES = [
  entry('a.ts', 'unstaged'),
  entry('a.ts', 'staged'),
  entry('b.ts', 'unstaged'),
  entry('c.ts', 'untracked')
]

const mounted: { container: HTMLDivElement; root: Root }[] = []

beforeEach(() => {
  state.activeModal = 'agent-session-fork'
  state.modalData = {
    sourceWorktreeId: 'repo::wt',
    launchSource: 'sidebar',
    preselectedPaneKey: null,
    transcript: null
  }
  state.closeModal.mockReset()
  mocks.runAgentSessionFork.mockReset()
  mocks.runAgentSessionFork.mockResolvedValue({ ok: true, worktreeId: 'repo::child', warnings: [] })
  mocks.copyTranscriptPrompt.mockReset()
  mocks.getRuntimeGitStatus.mockReset()
  mocks.getRuntimeGitStatus.mockResolvedValue(statusWith([]))
  mocks.isWorkingTreeCarrySupported.mockReset()
  mocks.isWorkingTreeCarrySupported.mockResolvedValue(true)
  mocks.listForkableAgentSessions.mockReset()
  mocks.listForkableAgentSessions.mockReturnValue([session('s1')])
  mocks.toastWarning.mockReset()
  mocks.toastMessage.mockReset()
  mocks.toastError.mockReset()
})

afterEach(() => {
  for (const { root, container } of mounted) {
    act(() => root.unmount())
    container.remove()
  }
  mounted.length = 0
  document.body.innerHTML = ''
})

async function renderDialog(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mounted.push({ container, root })
  act(() => {
    root.render(<AgentSessionForkDialog />)
  })
  // Why: lets the git status and capability probes resolve.
  await act(async () => {})
}

function bodyText(): string {
  return document.body.textContent ?? ''
}

function sessionTrigger(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="select-trigger"]')
}

function nameInput(): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('label')).find(
    (element) => element.textContent === 'Name'
  )
  const input = label ? document.getElementById(label.htmlFor) : null
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('name input not rendered')
  }
  return input
}

function carrySwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label^="Bring uncommitted changes"]'
  )
}

function buttonByText(text: string): HTMLButtonElement {
  const button = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (element) => element.textContent?.trim() === text
  )
  if (!button) {
    throw new Error(`button "${text}" not rendered`)
  }
  return button
}

async function openSessionSelect(): Promise<string[]> {
  const trigger = sessionTrigger()
  expect(trigger, 'session select').toBeTruthy()
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (option) => option.textContent ?? ''
  )
}

async function submitWithEnter(): Promise<void> {
  const input = nameInput()
  // Why: happy-dom lacks implicit submission; requestSubmit is what Enter in a form field runs.
  await act(async () => {
    input.form?.requestSubmit()
  })
}

describe('AgentSessionForkDialog', () => {
  it('renders nothing for other modals', async () => {
    state.activeModal = 'edit-meta'
    await renderDialog()
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })

  it('hides the session selector when the workspace has exactly one forkable session', async () => {
    await renderDialog()
    expect(document.querySelector('[role="dialog"]')).toBeTruthy()
    expect(sessionTrigger()).toBeNull()
  })

  it('shows the session selector with a "No agent" option when there are several sessions', async () => {
    mocks.listForkableAgentSessions.mockReturnValue([session('s1'), session('s2')])
    await renderDialog()
    expect(sessionTrigger()?.textContent).toContain('Session s1')
    const options = await openSessionSelect()
    expect(options).toHaveLength(3)
    expect(options[0]).toContain('Session s1')
    expect(options[1]).toContain('Session s2')
    expect(options[2]).toContain('No agent (branch only)')
  })

  it('offers only "No agent" and still creates a child workspace when there are no sessions', async () => {
    mocks.listForkableAgentSessions.mockReturnValue([])
    await renderDialog()
    const options = await openSessionSelect()
    expect(options).toEqual(['No agent (branch only)'])
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    await submitWithEnter()
    expect(mocks.runAgentSessionFork).toHaveBeenCalledWith(
      expect.objectContaining({ source: { kind: 'none' }, asChild: true }),
      expect.any(Function)
    )
  })

  it('prefills the name with "<workspace>-fork" and focuses it', async () => {
    await renderDialog()
    const input = nameInput()
    expect(input.value).toBe('fix-auth-fork')
    expect(document.activeElement).toBe(input)
  })

  it('shows the carry switch only when the parent has uncommitted changes, with counts', async () => {
    await renderDialog()
    expect(carrySwitch()).toBeNull()
    expect(bodyText()).not.toContain('Bring uncommitted changes')
    act(() => mounted[0]?.root.unmount())
    mounted.length = 0

    mocks.getRuntimeGitStatus.mockResolvedValue(statusWith(DIRTY_ENTRIES))
    await renderDialog()
    expect(bodyText()).toContain('Bring uncommitted changes (2 modified, 1 new)')
    expect(bodyText()).toContain('Staging is not preserved.')
    expect(carrySwitch()?.disabled).toBe(false)
    expect(carrySwitch()?.getAttribute('aria-checked')).toBe('true')
    expect(mocks.getRuntimeGitStatus).toHaveBeenCalledWith(
      {
        settings,
        worktreeId: 'repo::wt',
        worktreePath: '/repos/wt',
        connectionId: 'ssh-1'
      },
      expect.objectContaining({ admissionTier: 'interactive', includeLineStats: false })
    )
  })

  it('disables the carry switch after choosing another base in Advanced', async () => {
    mocks.getRuntimeGitStatus.mockResolvedValue(statusWith(DIRTY_ENTRIES))
    await renderDialog()
    act(() => buttonByText('Advanced').click())
    const picker = document.querySelector<HTMLButtonElement>('[data-testid="create-from-picker"]')
    expect(picker).toBeTruthy()
    act(() => picker?.click())
    expect(carrySwitch()?.disabled).toBe(true)
    expect(carrySwitch()?.getAttribute('aria-checked')).toBe('false')
    expect(bodyText()).toContain(
      'Only available when starting from the current commit of Fix auth.'
    )

    await submitWithEnter()
    expect(mocks.runAgentSessionFork).toHaveBeenCalledWith(
      expect.objectContaining({ carryChanges: false, baseBranchOverride: 'main' }),
      expect.any(Function)
    )
  })

  it('disables the carry switch when the runtime host lacks the capability', async () => {
    mocks.getRuntimeGitStatus.mockResolvedValue(statusWith(DIRTY_ENTRIES))
    mocks.isWorkingTreeCarrySupported.mockResolvedValue(false)
    await renderDialog()
    expect(carrySwitch()?.disabled).toBe(true)
    expect(bodyText()).toContain('This host does not support bringing changes.')
  })

  it('explains the transcript fallback for agents without native fork', async () => {
    mocks.listForkableAgentSessions.mockReturnValue([])
    state.modalData = {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: 'tab-9:pane-1',
      transcript: { agent: 'gemini', prompt: 'transcript prompt' }
    }
    await renderDialog()
    expect(bodyText()).toContain(
      'This agent will get the transcript as a draft instead of the conversation history.'
    )
    mocks.copyTranscriptPrompt.mockResolvedValue(true)
    await act(async () => buttonByText('Copy Context').click())
    expect(mocks.copyTranscriptPrompt).toHaveBeenCalledWith('transcript prompt')
    expect(state.closeModal).toHaveBeenCalled()
  })

  it('submits on Enter with the chosen options and closes on success', async () => {
    const s1 = session('s1')
    mocks.listForkableAgentSessions.mockReturnValue([s1])
    mocks.getRuntimeGitStatus.mockResolvedValue(statusWith(DIRTY_ENTRIES))
    await renderDialog()
    const submitButton = buttonByText('Create Fork')
    expect(submitButton.type).toBe('submit')
    expect(submitButton.form).toBe(nameInput().form)

    await submitWithEnter()
    expect(mocks.runAgentSessionFork).toHaveBeenCalledWith(
      {
        sourceWorktreeId: 'repo::wt',
        name: 'fix-auth-fork',
        source: { kind: 'native', session: s1 },
        asChild: true,
        carryChanges: true,
        sourceHeadOid: HEAD_OID,
        baseBranchOverride: null,
        launchSource: 'sidebar'
      },
      expect.any(Function)
    )
    expect(state.closeModal).toHaveBeenCalled()
    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })

  it('shows stage labels while busy and keeps the dialog open on error', async () => {
    let finish: (value: unknown) => void = () => {}
    mocks.runAgentSessionFork.mockImplementation(
      async (_request: unknown, onStage: (stage: string) => void) => {
        onStage('creating')
        return new Promise((resolve) => {
          finish = resolve
        })
      }
    )
    await renderDialog()
    await submitWithEnter()
    expect(buttonByText('Create Fork').disabled).toBe(true)
    expect(bodyText()).not.toContain('Creating worktree…')
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 250))
    })
    expect(bodyText()).toContain('Creating worktree…')

    await act(async () => finish({ ok: false, error: 'boom' }))
    expect(document.querySelector('[role="alert"]')?.textContent).toBe('boom')
    expect(bodyText()).not.toContain('Creating worktree…')
    expect(state.closeModal).not.toHaveBeenCalled()
  })

  it('warns when the changes were not carried, naming the reason', async () => {
    mocks.runAgentSessionFork.mockResolvedValue({
      ok: true,
      worktreeId: 'repo::child',
      warnings: [
        { kind: 'changes-not-carried', reason: 'too_large' },
        { kind: 'agent-not-started' }
      ]
    })
    await renderDialog()
    await submitWithEnter()
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Created fix-auth-fork without your uncommitted changes.',
      { description: 'Too many new files to copy.' }
    )
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'Created fix-auth-fork, but the agent could not start.'
    )
  })

  it('does not claim changes were left behind when the carry may have partially applied', async () => {
    mocks.runAgentSessionFork.mockResolvedValue({
      ok: true,
      worktreeId: 'repo::child',
      warnings: [{ kind: 'changes-not-carried', reason: 'partially_applied' }]
    })
    await renderDialog()
    await submitWithEnter()
    expect(mocks.toastWarning).toHaveBeenCalledExactlyOnceWith(
      'Created fix-auth-fork, but it is unclear whether all your uncommitted changes were copied.',
      {
        description:
          'Some uncommitted changes may already be in the new worktree. Review its changes before continuing.'
      }
    )
  })

  it('leaves the agent-not-started notice to the clipboard fallback for transcripts', async () => {
    mocks.listForkableAgentSessions.mockReturnValue([])
    state.modalData = {
      sourceWorktreeId: 'repo::wt',
      launchSource: 'terminal_context_menu',
      preselectedPaneKey: 'tab-9:pane-1',
      transcript: { agent: 'gemini', prompt: 'transcript prompt' }
    }
    mocks.runAgentSessionFork.mockResolvedValue({
      ok: true,
      worktreeId: 'repo::child',
      warnings: [{ kind: 'agent-not-started' }]
    })
    await renderDialog()
    await submitWithEnter()
    expect(mocks.runAgentSessionFork).toHaveBeenCalledWith(
      expect.objectContaining({
        source: { kind: 'transcript', agent: 'gemini', prompt: 'transcript prompt' },
        launchSource: 'terminal_context_menu'
      }),
      expect.any(Function)
    )
    expect(mocks.toastWarning).not.toHaveBeenCalled()
  })
})
