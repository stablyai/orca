import { act, fireEvent, getByRole, waitFor } from '@testing-library/react'
import { expect } from 'vitest'
import type { Root } from 'react-dom/client'
import { useAppStore } from '@/store'
import { getDefaultSettings } from '../../../../shared/constants'
import { makeWorktree, TEST_REPO } from '@/store/slices/worktrees-slice-test-fixtures'
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
    await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
    expect(document.activeElement).toBe(input)
    fireEvent.keyDown(document.activeElement!, { key: 'Escape' })
    await waitFor(() => expect(document.querySelector('textarea')).toBeNull())
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
    await waitFor(() => expect(document.querySelector('textarea')).not.toBeNull())
  }
  const close = () => fireEvent.keyDown(document.querySelector('textarea')!, { key: 'Escape' })
  try {
    await showEntries(false)
    await configure()
    fireEvent.change(document.querySelector('textarea')!, {
      target: { value: '--ordinary-pending' }
    })
    close()
    await showEntries(true)
    fireEvent.change(document.querySelector('input')!, { target: { value: 'Astra low' } })
    await configure()
    expect(document.querySelector('textarea')).not.toHaveProperty('value', '--ordinary-pending')
    fireEvent.change(document.querySelector('textarea')!, {
      target: { value: '--model private/preset --preset-pending' }
    })
    fireEvent.click(getByRole(document.body, 'radio', { name: 'Low' }))
    close()
    await showEntries(false)
    await configure()
    expect(document.querySelector('textarea')).toHaveProperty('value', '--ordinary-pending')
    close()
    await showEntries(true)
    fireEvent.change(document.querySelector('input')!, { target: { value: 'Astra low' } })
    await configure()
    expect(document.querySelector('textarea')).toHaveProperty('value', '--preset-pending')
    expect(document.body.textContent).toContain('private/preset')
    expect(launch).not.toHaveBeenCalled()
  } finally {
    restore()
  }
}
