import { act, fireEvent, getByRole, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import type { Root } from 'react-dom/client'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree } from '@/store/slices/worktrees/worktree.test-fixture'
import { TEST_REPO } from '@/store/repos/repo.test-fixture'
import { useNewTabAgentMenuRows } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from './use-agent-launch-picker-inventory'
import TabBarCreateEntry from '../tab-bar/TabBarCreateEntry'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'

function mountOmniboxEntries(root: Root, launch: (...args: unknown[]) => void) {
  const previous = useAppStore.getState()
  const worktree = makeWorktree({
    repoId: 'repo1',
    id: 'repo1::/omnibox',
    path: '/omnibox',
    hostId: 'local'
  })
  useAppStore.setState({
    repos: [TEST_REPO],
    worktreesByRepo: { repo1: [worktree] },
    settings: {
      ...getDefaultSettings('/synthetic'),
      nativeChatProviders: {},
      agentPermissionDefault: 'own'
    },
    localDetectedAgentIdsByContext: { host: ['codex'] },
    ensureDetectedAgents: async () => ['codex']
  })
  function Entries({ search }: { search: boolean }) {
    const model = useNewTabAgentMenuRows(worktree.id, true, { kind: 'local', contextKey: 'host' })
    const entries = useAgentLaunchPickerInventory(worktree.id, model, true)
    return (
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          {search ? (
            <TabBarCreateEntry
              worktreeId={worktree.id}
              groupId="g"
              menuOpen
              onOpenEntry={async () => {}}
              agentPickerEntries={entries}
              onLaunchAgentOption={launch}
            />
          ) : (
            <AgentLaunchPickerMenu entries={entries} runLaunch={launch} />
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    )
  }
  const showEntries = async (search: boolean) => {
    act(() =>
      root.render(
        <TooltipProvider>
          <Entries search={search} />
        </TooltipProvider>
      )
    )
    await waitFor(() => expect(document.querySelector('input')).not.toBeNull())
  }
  const restore = () =>
    act(() => {
      root.render(<div />)
      useAppStore.setState(previous, true)
    })
  return { showEntries, restore }
}

const configureButton = () =>
  document.querySelector<HTMLButtonElement>('button[aria-label="Configure Codex"]')

const setupPanel = () =>
  document.querySelector<HTMLElement>('[data-slot="dropdown-menu-sub-content"]')

async function waitForConfigure() {
  await waitFor(() => expect(configureButton()).not.toBeNull())
  await waitFor(() => expect(configureButton()).toHaveProperty('disabled', false))
  return configureButton()!
}

export async function verifyOmniboxSetupKeepsSearchFocus(
  root: Root,
  launch: (...args: unknown[]) => void
) {
  const { showEntries, restore } = mountOmniboxEntries(root, launch)
  try {
    await showEntries(true)
    const input = document.querySelector('input')!
    fireEvent.change(input, { target: { value: 'Astra low' } })
    input.focus()
    const configure = await waitForConfigure()
    // Typing can shift a row under a resting pointer: that boundary crossing alone must not open setup.
    fireEvent.keyDown(input, { key: 'w' })
    fireEvent.pointerOver(configure, { pointerType: 'mouse' })
    expect(configure.getAttribute('aria-expanded')).toBe('false')
    fireEvent.pointerMove(configure, { pointerType: 'mouse' })
    await waitFor(() => expect(setupPanel()).not.toBeNull())
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(setupPanel()).toBeNull())
    expect(document.activeElement).toBe(input)
    expect(launch).not.toHaveBeenCalled()
  } finally {
    restore()
  }
}

export async function verifyOmniboxPresetIdentity(
  root: Root,
  launch: (...args: unknown[]) => void
) {
  const { showEntries, restore } = mountOmniboxEntries(root, launch)
  const configure = async () => {
    fireEvent.click(await waitForConfigure())
    await waitFor(() => expect(effort('Low')).not.toBeNull())
  }
  const close = () => fireEvent.keyDown(setupPanel()!, { key: 'Escape' })
  const effort = (label: string) =>
    getByRole(document.body, 'radio', { name: label }).getAttribute('data-state')
  try {
    await showEntries(false)
    await configure()
    fireEvent.click(getByRole(document.body, 'radio', { name: 'High' }))
    close()
    await showEntries(true)
    fireEvent.change(document.querySelector('input')!, { target: { value: 'Astra low' } })
    await configure()
    expect(effort('Low')).toBe('on')
    close()
    await showEntries(false)
    await configure()
    expect(effort('High')).toBe('on')
    close()
    await showEntries(true)
    fireEvent.change(document.querySelector('input')!, { target: { value: 'Astra low' } })
    await configure()
    expect(effort('Low')).toBe('on')
    expect(launch).not.toHaveBeenCalled()
  } finally {
    restore()
  }
}
