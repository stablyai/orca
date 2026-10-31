import { act, fireEvent, waitFor } from '@testing-library/react'
import { expect, type vi } from 'vitest'
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

export async function verifyOmniboxPresetIdentity(root: Root, launch: ReturnType<typeof vi.fn>) {
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
    return search ? (
      <TabBarCreateEntry
        worktreeId={worktree.id}
        groupId="g"
        menuOpen
        onOpenEntry={async () => {}}
        agentPickerEntries={entries}
        onLaunchAgentOption={launch}
      />
    ) : (
      <DropdownMenu defaultOpen modal={false}>
        <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
        <DropdownMenuContent>
          <AgentLaunchPickerMenu entries={entries} runLaunch={launch} />
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
  const configure = async () => {
    await waitFor(() =>
      expect(document.querySelector('button[aria-label="Configure Codex"]')).not.toBeNull()
    )
    await waitFor(() =>
      expect(document.querySelector('button[aria-label="Configure Codex"]')).toHaveProperty(
        'disabled',
        false
      )
    )
    fireEvent.click(document.querySelector('button[aria-label="Configure Codex"]')!)
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
    fireEvent.blur(document.querySelector('textarea')!)
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
    act(() => {
      root.render(<div />)
      useAppStore.setState(previous, true)
    })
  }
}
