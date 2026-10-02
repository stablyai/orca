import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { expect } from 'vitest'
import type { ForkableAgentSession } from '@/lib/worktree-agent-fork-sessions'
import type { GitStatusEntry, GitStatusResult } from '../../../../shared/git-status-types'
import AgentSessionForkDialog from './AgentSessionForkDialog'

export const HEAD_OID = 'a'.repeat(40)

export function session(
  id: string,
  overrides: Partial<ForkableAgentSession> = {}
): ForkableAgentSession {
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

export function statusWith(entries: GitStatusEntry[]): GitStatusResult {
  return { entries, conflictOperation: 'unknown', head: HEAD_OID }
}

export const DIRTY_ENTRIES = [
  entry('a.ts', 'unstaged'),
  entry('a.ts', 'staged'),
  entry('b.ts', 'unstaged'),
  entry('c.ts', 'untracked')
]

export const mountedDialogs: { container: HTMLDivElement; root: Root }[] = []

export function unmountDialogs(): void {
  for (const { root, container } of mountedDialogs) {
    act(() => root.unmount())
    container.remove()
  }
  mountedDialogs.length = 0
  document.body.innerHTML = ''
}

export async function renderDialog(): Promise<void> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedDialogs.push({ container, root })
  act(() => {
    root.render(<AgentSessionForkDialog />)
  })
  // Why: lets the git status and capability probes resolve.
  await act(async () => {})
}

/** Re-renders the mounted dialog in place, keeping its state, after the store mock changed. */
export async function rerenderDialog(): Promise<void> {
  const mounted = mountedDialogs.at(-1)
  act(() => {
    mounted?.root.render(<AgentSessionForkDialog />)
  })
  await act(async () => {})
}

export function bodyText(): string {
  return document.body.textContent ?? ''
}

export function sessionTrigger(): HTMLElement | null {
  return document.querySelector<HTMLElement>('[data-slot="select-trigger"]')
}

export function nameInput(): HTMLInputElement {
  const label = Array.from(document.querySelectorAll('label')).find(
    (element) => element.textContent === 'Name'
  )
  const input = label ? document.getElementById(label.htmlFor) : null
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('name input not rendered')
  }
  return input
}

export function carrySwitch(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    'button[role="switch"][aria-label^="Bring uncommitted changes"]'
  )
}

export function findButton(text: string): HTMLButtonElement | undefined {
  return Array.from(document.querySelectorAll<HTMLButtonElement>('button')).find(
    (element) => element.textContent?.trim() === text
  )
}

export function buttonByText(text: string): HTMLButtonElement {
  const button = findButton(text)
  if (!button) {
    throw new Error(`button "${text}" not rendered`)
  }
  return button
}

export async function openSessionSelect(): Promise<string[]> {
  const trigger = sessionTrigger()
  expect(trigger, 'session select').toBeTruthy()
  await act(async () => {
    trigger?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  })
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (option) => option.textContent ?? ''
  )
}

export async function closeSessionSelect(): Promise<void> {
  await act(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })
}

export function pickerValue(): string | null {
  return (
    document.querySelector('[data-testid="create-from-picker"]')?.getAttribute('data-value') ?? null
  )
}

export async function submitWithEnter(): Promise<void> {
  const input = nameInput()
  // Why: happy-dom lacks implicit submission; requestSubmit is what Enter in a form field runs.
  await act(async () => {
    input.form?.requestSubmit()
  })
}
