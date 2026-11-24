// @vitest-environment happy-dom
import { act } from 'react'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/index'
import type { TitlebarChromeFoldLevel } from '@/app-shell/chrome/titlebar-chrome-fold'
import { getDefaultSettings } from '../../../../../shared/orca-profiles/constants'
import type { TerminalQuickCommand } from '../../../../../shared/terminal/quick-commands/terminal-quick-command-types'
import { TooltipProvider } from '@/components/ui/tooltip'
import { ConfirmationDialogProvider } from '../../dismiss/confirmation/confirmation-dialog'
import { TabGroupStripActions } from './TabGroupStripActions'

const repoId = 'demo-repo'
const worktreeId = `${repoId}::/demo/project/orchid`
const initial = useAppStore.getState()
let saved: TerminalQuickCommand[]

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true)
  // happy-dom applies no Tailwind; a folded strip parks the quick-command slot with `invisible`.
  const style = document.createElement('style')
  style.textContent = '.invisible { visibility: hidden; }'
  document.head.append(style)
  // happy-dom has no layout; treat connected elements as shown.
  Object.defineProperty(HTMLElement.prototype, 'offsetParent', {
    configurable: true,
    get(this: HTMLElement) {
      return this.isConnected ? document.body : null
    }
  })
  saved = []
  useAppStore.setState({
    settings: {
      ...(initial.settings ?? getDefaultSettings('/fixture-home')),
      terminalQuickCommands: [
        {
          id: 'demo-command',
          label: 'Check formatting',
          command: 'npm run format:check',
          appendEnter: false,
          scope: { type: 'global' }
        }
      ]
    },
    repos: [
      { id: repoId, path: '/demo/project', displayName: 'Orchid', badgeColor: '', addedAt: 1 }
    ],
    // This pane owns focus, so a closing editor may hand focus back into it.
    activeWorktreeId: worktreeId,
    activeGroupIdByWorktree: { [worktreeId]: 'demo-group' },
    upsertTerminalQuickCommand: async (_hostId, command) => {
      saved.push(command)
      return true
    }
  })
})

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(HTMLElement.prototype, 'offsetParent')
  document.head.innerHTML = ''
  useAppStore.setState(initial, true)
  vi.unstubAllGlobals()
})

function Strip({ fold, split }: { fold: TitlebarChromeFoldLevel; split: boolean }) {
  return (
    <TooltipProvider>
      <ConfirmationDialogProvider>
        <div data-tab-group-strip-id="demo-group">
          <div data-tab-strip-slot="demo-tab">
            <div tabIndex={0} data-active="true" aria-label="Active tab" />
          </div>
          <TabGroupStripActions
            isFocused
            worktreeId={worktreeId}
            groupId="demo-group"
            onCloseGroup={split ? () => undefined : undefined}
            foldLevel={fold}
            onNewTab={() => undefined}
          />
        </div>
      </ConfirmationDialogProvider>
    </TooltipProvider>
  )
}

function paneActionsTrigger(): HTMLElement {
  return document.querySelector<HTMLElement>('[data-pane-actions-menu-trigger]')!
}

async function openPaneActions(): Promise<void> {
  const trigger = paneActionsTrigger()
  await act(async () => {
    trigger.focus()
    fireEvent.keyDown(trigger, { key: 'Enter' })
  })
  expect(screen.getByRole('menu')).toBeTruthy()
}

async function chooseAddQuickCommand(): Promise<void> {
  const quickCommands = screen.getByRole('menuitem', { name: 'Quick Commands' })
  await act(async () => {
    quickCommands.focus()
    fireEvent.keyDown(quickCommands, { key: 'ArrowRight' })
  })
  const add = await screen.findByRole('menuitem', { name: 'Add Quick Command…' })
  await act(async () => {
    fireEvent.click(add)
  })
}

function editorLabel(): HTMLInputElement {
  const input = within(
    screen.getByRole('dialog', { name: 'Add Quick Command' })
  ).getByPlaceholderText('Start dev server')
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('The Add Quick Command label is not an input')
  }
  return input
}

async function fillAndSave(label: string): Promise<void> {
  const dialog = screen.getByRole('dialog', { name: 'Add Quick Command' })
  const textarea = dialog.querySelector('textarea')!
  await act(async () => {
    fireEvent.change(editorLabel(), { target: { value: label } })
    fireEvent.change(textarea, { target: { value: 'npm run lint' } })
  })
  await act(async () => {
    fireEvent.click(within(dialog).getByRole('button', { name: /^Save/ }))
  })
}

describe('TabGroupStripActions quick-command editor custody', () => {
  for (const split of [false, true]) {
    const pane = split ? 'split' : 'unsplit'

    it(`opens a working Add editor from a menu kept open through a fold to 0 (${pane})`, async () => {
      const { rerender } = render(<Strip fold={1} split={split} />)
      await openPaneActions()
      rerender(<Strip fold={0} split={split} />)
      await chooseAddQuickCommand()

      expect(screen.queryByRole('menu')).toBeNull()
      expect(screen.getByRole('dialog', { name: 'Add Quick Command' })).toBeTruthy()
      await fillAndSave('Lint the repo')
      expect(saved.map((command) => command.label)).toEqual(['Lint the repo'])
      expect(screen.queryByRole('dialog', { name: 'Add Quick Command' })).toBeNull()
    })

    it(`keeps an unsaved draft when the pane folds to 0 under the open editor (${pane})`, async () => {
      const { rerender } = render(<Strip fold={1} split={split} />)
      await openPaneActions()
      await chooseAddQuickCommand()
      await act(async () => {
        fireEvent.change(editorLabel(), { target: { value: 'Draft label' } })
      })

      rerender(<Strip fold={0} split={split} />)

      expect(editorLabel().value).toBe('Draft label')
      const dialog = screen.getByRole('dialog', { name: 'Add Quick Command' })
      await act(async () => {
        fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
      })
      expect(screen.queryByRole('dialog', { name: 'Add Quick Command' })).toBeNull()
      expect(saved).toEqual([])
    })
  }
})

/** Radix returns close focus in a timeout after unmount; the strip then defers one frame. */
async function settleCloseFocus(): Promise<void> {
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
  await act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())))
}

async function closeEditor(how: 'Save' | 'Cancel' | 'Escape'): Promise<void> {
  const dialog = screen.getByRole('dialog', { name: 'Add Quick Command' })
  if (how === 'Save') {
    await fillAndSave('Lint the repo')
  } else if (how === 'Cancel') {
    await act(async () => {
      fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    })
  } else {
    await act(async () => {
      fireEvent.keyDown(editorLabel(), { key: 'Escape' })
    })
  }
  expect(screen.queryByRole('dialog', { name: 'Add Quick Command' })).toBeNull()
  await settleCloseFocus()
}

describe('TabGroupStripActions focus after the Add Quick Command editor closes', () => {
  for (const split of [false, true]) {
    const pane = split ? 'split' : 'unsplit'
    for (const how of ['Save', 'Cancel', 'Escape'] as const) {
      it(`lands on the pane's ⋯ after ${how} (${pane}, still folded)`, async () => {
        render(<Strip fold={1} split={split} />)
        await openPaneActions()
        await chooseAddQuickCommand()
        await closeEditor(how)
        expect(document.activeElement).toBe(paneActionsTrigger())
      })

      it(`lands on a shown control after ${how} once the pane unfolds to 0 (${pane})`, async () => {
        const { rerender } = render(<Strip fold={1} split={split} />)
        await openPaneActions()
        await chooseAddQuickCommand()
        await act(async () => {
          fireEvent.change(editorLabel(), { target: { value: 'Draft label' } })
        })
        rerender(<Strip fold={0} split={split} />)
        await closeEditor(how)
        // Unsplit at fold 0 has no ⋯, so the active tab takes focus; split keeps its ⋯.
        expect(document.activeElement).toBe(
          split ? paneActionsTrigger() : screen.getByLabelText('Active tab')
        )
      })
    }
  }
})
