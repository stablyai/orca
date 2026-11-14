import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildAgentPickerLaunchOptions } from './tab-agent-launch-options'
import type { AgentPickerEntry } from '../../../../shared/agent-launch/picker/agent-launch-picker'
// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import { useAppStore } from '@/store'
import type { AppState } from '@/store/types'

const fileListMock = vi.hoisted(() => ({
  current: { files: [] as string[], loading: false, loadError: null as string | null }
}))
vi.mock('../quick-open-file-list', () => ({
  useRuntimeFileListForWorktree: () => fileListMock.current
}))

const tabSearchMock = vi.hoisted(() => ({
  calls: [] as { enabled: boolean; query: string }[],
  results: [] as unknown[]
}))
vi.mock('./use-open-tab-search', () => ({
  useOpenTabSearch: ({ enabled, query }: { enabled: boolean; query: string }) => {
    tabSearchMock.calls.push({ enabled, query })
    return { query, results: tabSearchMock.results }
  }
}))

import TabBarCreateEntry from './TabBarCreateEntry'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let container: HTMLDivElement
let root: Root

function renderEntry(props: Record<string, unknown> = {}): void {
  act(() => {
    root.render(
      <TooltipProvider>
        {/* Agent setup is a submenu, so results render inside the + menu as in the app. */}
        <DropdownMenu defaultOpen modal={false}>
          <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
          <DropdownMenuContent>
            <TabBarCreateEntry
              worktreeId="wt"
              groupId="g"
              menuOpen
              onOpenEntry={vi.fn().mockResolvedValue(undefined)}
              {...props}
            />
          </DropdownMenuContent>
        </DropdownMenu>
      </TooltipProvider>
    )
  })
}

function setQuery(value: string): void {
  const input = document.querySelector('input')!
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    'value'
  )?.set
  act(() => {
    nativeSetter?.call(input, value)
    input.dispatchEvent(new window.Event('input', { bubbles: true }))
  })
}

function submit(): void {
  act(() => {
    document
      .querySelector('form')!
      .dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  })
}

beforeEach(() => {
  fileListMock.current = { files: [], loading: false, loadError: null }
  tabSearchMock.calls = []
  tabSearchMock.results = []
  useAppStore.setState(
    { ...useAppStore.getInitialState(), browserDefaultSearchEngine: null } as AppState,
    true
  )
  container = document.createElement('div')
  document.body.appendChild(container)
  root = createRoot(container)
})

afterEach(() => {
  act(() => root.unmount())
  container.remove()
  vi.clearAllMocks()
})

describe('TabBarCreateEntry search behavior', () => {
  it('disables the active submission and exposes failures to assistive technology', async () => {
    let rejectOpen: ((error: Error) => void) | undefined
    const onOpenEntry = vi.fn(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectOpen = reject
        })
    )
    renderEntry({ onOpenEntry })
    setQuery('react hooks')
    submit()

    // Read-only rather than disabled so the pending input keeps keyboard focus.
    expect(document.querySelector('input')?.disabled).toBe(false)
    expect(document.querySelector('input')?.readOnly).toBe(true)
    expect(document.querySelector('input')?.getAttribute('aria-busy')).toBe('true')
    expect(document.querySelector<HTMLButtonElement>('[role="option"]')?.disabled).toBe(true)
    expect(document.querySelector('[role="option"] .animate-spin')).not.toBeNull()

    await act(async () => rejectOpen?.(new Error('Search failed safely.')))

    const input = document.querySelector('input')!
    expect(input.readOnly).toBe(false)
    expect(input.getAttribute('aria-busy')).toBeNull()
    expect(input.getAttribute('aria-expanded')).toBe('false')
    expect(input.getAttribute('aria-errormessage')).toBe('tab-create-entry-error')
    expect(document.querySelector('#tab-create-entry-error')?.textContent).toContain(
      'Search failed safely.'
    )
  })
})

it.each([false, true])(
  'configures a waiting terminal search result to chat while preserving independent disabled=%s',
  async (independentlyDisabled) => {
    const entry: AgentPickerEntry = {
      agent: 'codex',
      label: 'Codex',
      defaultSurface: 'terminal',
      surfaces: ['terminal', 'chat'],
      terminal: {},
      structured: {},
      catalog: { origin: 'probe', fetchedAt: 1, models: [] },
      rows: [{ kind: 'cli', agent: 'codex', chat: true }]
    }
    const onLaunchAgentOption = vi.fn(() => true)
    renderEntry({
      agentOptions: buildAgentPickerLaunchOptions([entry]).map((option) => ({
        ...option,
        disabled: independentlyDisabled
      })),
      terminalPending: true,
      onLaunchAgentOption
    })
    setQuery('codex')
    submit()
    expect(onLaunchAgentOption).not.toHaveBeenCalled()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: 'Configure Codex' }))
    expect(screen.getByRole('button', { name: 'Launch terminal' }).hasAttribute('disabled')).toBe(
      true
    )
    await user.click(screen.getByRole('button', { name: 'Launch chat' }))
    expect(onLaunchAgentOption).toHaveBeenCalledTimes(independentlyDisabled ? 0 : 1)
    if (!independentlyDisabled) {
      expect(onLaunchAgentOption).toHaveBeenCalledWith(
        expect.objectContaining({ row: expect.objectContaining({ kind: 'chat' }) })
      )
    }
    expect(document.querySelector('[data-sonner-toast]')).toBeNull()
  }
)
