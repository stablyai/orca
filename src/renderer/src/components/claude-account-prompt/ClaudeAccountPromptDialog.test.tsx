// @vitest-environment happy-dom

import React, { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Repo } from '../../../../shared/repo-types'
import type { GlobalSettings } from '../../../../shared/global-settings-types'
import type { ClaudeManagedAccountSummary } from '../../../../shared/managed-account-types'
import { useAppStore } from '@/store'
import ClaudeAccountPromptDialog from './ClaudeAccountPromptDialog'
import { resetClaudeAccountPromptForTests } from './claude-account-prompt-state'
import { chooseClaudeLaunchAccount } from './choose-claude-launch-account'
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog'

// Why: Radix Select needs pointer/layout APIs happy-dom lacks; a native select keeps the value testable.
vi.mock('@/components/ui/select', () => ({
  Select: ({
    value,
    onValueChange,
    children
  }: {
    value: string
    onValueChange: (value: string) => void
    children: React.ReactNode
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.currentTarget.value)}>
      {children}
    </select>
  ),
  SelectTrigger: () => null,
  SelectValue: () => null,
  SelectContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  SelectItem: ({ value, children }: { value: string; children: React.ReactNode }) => (
    <option value={value}>{children}</option>
  )
}))

const initialState = useAppStore.getInitialState()
let root: Root | null = null

function account(id: string, organizationName?: string): ClaudeManagedAccountSummary {
  return {
    id,
    email: `${id}@example.com`,
    organizationName,
    authMethod: 'subscription-oauth',
    createdAt: 0,
    updatedAt: 0,
    lastAuthenticatedAt: 0
  }
}

const repo: Repo = {
  id: 'repo-1',
  path: '/repo',
  displayName: 'Orca',
  badgeColor: '#000',
  addedAt: 0,
  agentAccounts: { claude: { mode: 'ask' } }
}

// oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: the prompt only reads askClaudeAccountPerProject.
const settings = {} as GlobalSettings

async function startPrompt(updateRepo = vi.fn(), surface: React.ReactNode = null) {
  const choice = chooseClaudeLaunchAccount({
    repo,
    settings,
    accounts: [account('work', 'Acme'), account('personal')],
    activeAccountId: 'personal',
    updateRepo
  })
  const container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
  await act(async () => {
    root?.render(
      <>
        {surface}
        <ClaudeAccountPromptDialog />
      </>
    )
  })
  return { choice, updateRepo }
}

function getButton(label: string): HTMLButtonElement {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  return button
}

function getSelect(): HTMLSelectElement {
  const select = document.body.querySelector('select')
  if (!select) {
    throw new Error('Select not found')
  }
  return select
}

describe('ClaudeAccountPromptDialog', () => {
  beforeEach(() => {
    useAppStore.setState(
      { ...initialState, activeModal: 'none', setContextualToursBlockingSurfaceVisible: vi.fn() },
      true
    )
  })

  afterEach(async () => {
    await act(async () => {
      root?.unmount()
    })
    root = null
    document.body.innerHTML = ''
    resetClaudeAccountPromptForTests()
    useAppStore.setState(initialState, true)
  })

  it('pre-selects the active account and cancels', async () => {
    const { choice, updateRepo } = await startPrompt()

    expect(document.body.textContent).toContain('Choose a Claude account')
    expect(document.body.textContent).toContain('Orca')
    expect(document.body.textContent).toContain('work@example.com · Acme')
    expect(getSelect().value).toBe('personal')

    await act(async () => {
      getButton('Cancel').click()
    })

    await expect(choice).resolves.toEqual({ kind: 'cancelled' })
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('remembers the pick for the project when Remember is checked', async () => {
    const { choice, updateRepo } = await startPrompt()

    await act(async () => {
      const select = getSelect()
      select.value = 'work'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    await act(async () => {
      getButton('Start').click()
    })

    await expect(choice).resolves.toEqual({ kind: 'default' })
    expect(updateRepo).toHaveBeenCalledWith('repo-1', {
      agentAccounts: { claude: { mode: 'account', accountId: 'work' } }
    })
  })

  it('uses the pick for this launch only when Remember is unchecked', async () => {
    const { choice, updateRepo } = await startPrompt()

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
    })
    await act(async () => {
      getButton('Start').click()
    })

    await expect(choice).resolves.toEqual({ kind: 'account', accountId: 'personal' })
    expect(updateRepo).not.toHaveBeenCalled()
  })

  it('opens over the New Workspace composer that is awaiting it', async () => {
    useAppStore.setState({ activeModal: 'new-workspace-composer' })
    const onComposerOpenChange = vi.fn()
    const composer = (
      <Dialog open onOpenChange={onComposerOpenChange}>
        <DialogContent>
          <DialogTitle>New workspace</DialogTitle>
        </DialogContent>
      </Dialog>
    )
    const { choice } = await startPrompt(vi.fn(), composer)

    expect(document.body.textContent).toContain('Choose a Claude account')
    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
    })
    await act(async () => {
      getButton('Start').click()
    })

    await expect(choice).resolves.toEqual({ kind: 'account', accountId: 'personal' })
    expect(onComposerOpenChange).not.toHaveBeenCalled()
    expect(useAppStore.getState().activeModal).toBe('new-workspace-composer')
  })

  it('stays hidden behind an unrelated modal', async () => {
    useAppStore.setState({ activeModal: 'confirm-orca-yaml-hooks' })
    await startPrompt()

    expect(document.body.textContent).not.toContain('Choose a Claude account')
  })
})
