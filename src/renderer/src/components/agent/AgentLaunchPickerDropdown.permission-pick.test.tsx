// @vitest-environment happy-dom
// A kept setup's permission row in the agent picker: the form hears that the user chose a permission,
// even the one already shown, so a bot from a link can tell a chosen Ask from a shown fallback.

import { act, fireEvent, waitFor } from '@testing-library/react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { TooltipProvider } from '@/components/ui/tooltip'
import { clearNativeChatComposerDraftsForTests } from '../native-chat/drafts/native-chat-draft-reset'
import {
  AgentLaunchPickerDropdown,
  type AgentLaunchPickerDropdownPick
} from './AgentLaunchPickerDropdown'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'

const codex: AgentPickerEntry = {
  agent: 'codex',
  label: 'Codex',
  rows: [{ agent: 'codex', kind: 'chat' }],
  surfaces: ['chat'],
  defaultSurface: 'chat',
  terminal: {},
  structured: { permissionMode: 'full-access' },
  arguments: '',
  catalog: { origin: 'unknown' },
  keptSetup: { permissions: ['ask', 'auto', 'full-access'], inheritLabel: 'Same as chats' }
}

// Codex showing Ask: the fallback for a kept Accept edits, which Codex lacks.
const shownAsk: AgentPickerDraft = {
  agent: 'codex',
  surface: 'chat',
  choices: { options: {}, permissionMode: 'ask' }
}

let root: Root
let host: HTMLDivElement
beforeEach(() => {
  clearNativeChatComposerDraftsForTests()
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  host = document.createElement('div')
  document.body.append(host)
  root = createRoot(host)
})
afterEach(() => {
  act(() => root.unmount())
  host.remove()
  vi.unstubAllGlobals()
})

function mount(onPick: AgentLaunchPickerDropdownPick) {
  const scope = {}
  act(() =>
    root.render(
      <TooltipProvider>
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>Agent</DropdownMenuTrigger>
          <DropdownMenuContent>
            <AgentLaunchPickerDropdown
              entries={[codex]}
              agent="codex"
              draftForEntry={() => shownAsk}
              draftScope={scope}
              selectAgentOnTab
              onPaneChange={() => {}}
              onPick={onPick}
              onClose={() => {}}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  )
}

async function choosePermission(name: RegExp) {
  const trigger = await waitFor(() => {
    const found = document.querySelector<HTMLButtonElement>(
      'button[aria-label="Codex permissions"]'
    )
    expect(found).not.toBeNull()
    return found!
  })
  act(() => {
    fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false, pointerType: 'mouse' })
  })
  const item = await waitFor(() => {
    const found = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')].find(
      (candidate) => name.test(candidate.textContent ?? '')
    )
    expect(found).toBeDefined()
    return found!
  })
  act(() => {
    fireEvent.click(item)
  })
}

it('reports choosing the Ask it already shows as a permission pick', async () => {
  const onPick = vi.fn<AgentLaunchPickerDropdownPick>()
  mount(onPick)
  await choosePermission(/^Ask/)
  await waitFor(() => expect(onPick).toHaveBeenCalled())
  const [agent, draft, , , permissionPicked] = onPick.mock.calls.at(-1)!
  expect(agent).toBe('codex')
  expect(draft?.choices.permissionMode).toBe('ask')
  expect(permissionPicked).toBe(true)
})

it('reports Same as chats as a permission pick too', async () => {
  const onPick = vi.fn<AgentLaunchPickerDropdownPick>()
  mount(onPick)
  await choosePermission(/^Same as chats/)
  await waitFor(() => expect(onPick).toHaveBeenCalled())
  const [, draft, , , permissionPicked] = onPick.mock.calls.at(-1)!
  expect(draft?.choices.permissionMode).toBeUndefined()
  expect(permissionPicked).toBe(true)
})
