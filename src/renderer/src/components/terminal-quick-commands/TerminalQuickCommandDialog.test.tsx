// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, type Mock, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { TerminalQuickCommandDialog } from './TerminalQuickCommandDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mountedRoots: Root[] = []

type RenderDialogOptions = {
  defaultAdvancedOpen?: boolean
  showBackgroundPreference?: boolean
  onSave?: Mock<(command: TerminalQuickCommand) => void>
}

async function renderDialog(
  command: TerminalQuickCommand,
  options: RenderDialogOptions = {}
): Promise<{ onSave: Mock<(command: TerminalQuickCommand) => void> }> {
  const onSave = options.onSave ?? vi.fn<(command: TerminalQuickCommand) => void>()
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(
      <TerminalQuickCommandDialog
        open={true}
        mode="add"
        command={command}
        repos={[]}
        defaultAdvancedOpen={options.defaultAdvancedOpen}
        showBackgroundPreference={options.showBackgroundPreference ?? true}
        onOpenChange={vi.fn()}
        onSave={onSave}
      />
    )
  })
  return { onSave }
}

function findAnimatedRowContaining(text: string): HTMLElement {
  const row = Array.from(document.body.querySelectorAll<HTMLElement>('[aria-hidden]')).find(
    (element) => element.textContent?.includes(text)
  )
  if (!row) {
    throw new Error(`Could not find animated row containing ${text}`)
  }
  return row
}

describe('TerminalQuickCommandDialog animation structure', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('keeps agent-only fields mounted as collapsed animated rows in terminal mode', async () => {
    await renderDialog({
      id: 'qc-1',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    const agentRow = findAnimatedRowContaining('Agent')

    expect(agentRow.getAttribute('aria-hidden')).toBe('true')
    expect(agentRow.className).toContain('transition-[grid-template-rows]')
    expect(agentRow.className).toContain('grid-rows-[0fr]')
  })

  it('shows append enter in the editor footer for terminal commands', async () => {
    await renderDialog({
      id: 'qc-2',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    expect(document.body.textContent).toContain('Append Enter — run immediately')
    expect(document.body.textContent).not.toContain('Supports /goal, skills, paths')
  })

  it('hides append enter and shows agent toolbar hint in agent mode', async () => {
    await renderDialog({
      id: 'qc-3',
      label: 'Investigate',
      action: 'agent-prompt',
      agent: 'claude',
      prompt: 'Look into the build',
      scope: { type: 'global' }
    })

    expect(document.body.textContent).toContain('Supports /goal, skills, paths')
    expect(document.body.textContent).not.toContain('Append Enter — run immediately')
  })

  it('shows scope summary on the collapsed advanced toggle', async () => {
    await renderDialog({
      id: 'qc-4',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: true,
      scope: { type: 'global' }
    })

    expect(document.body.textContent).toMatch(/Advanced\s*·\s*Global/)
  })

  it('opens the advanced section when defaultAdvancedOpen is true', async () => {
    await renderDialog(
      {
        id: 'qc-5',
        label: 'Start dev server',
        action: 'terminal-command',
        command: 'npm run dev',
        appendEnter: true,
        scope: { type: 'global' }
      },
      { defaultAdvancedOpen: true }
    )

    const advancedToggle = document.body.querySelector('[aria-expanded="true"]')
    expect(advancedToggle?.textContent).toContain('Advanced')
    expect(document.body.textContent).not.toMatch(/Advanced\s*·\s*Global/)
  })

  it('saves background presentation for agent prompt commands', async () => {
    const { onSave } = await renderDialog({
      id: 'qc-1',
      label: 'Review',
      action: 'agent-prompt',
      agent: 'codex',
      prompt: 'Review this diff',
      scope: { type: 'global' }
    })
    const advanced = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Advanced')
    )
    const background = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle open in background"]'
    )
    const save = document.body.querySelector<HTMLButtonElement>('button[title^="Save ("]')

    expect(advanced).toBeTruthy()
    expect(background).toBeTruthy()
    expect(save).toBeTruthy()
    await act(async () => {
      advanced!.click()
    })
    await act(async () => {
      background!.click()
    })
    await act(async () => {
      save!.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ openInBackground: true, action: 'agent-prompt' })
    )
  })

  it('preserves append-enter when enabling background and exposes the canonical focus ring', async () => {
    const { onSave } = await renderDialog({
      id: 'qc-1',
      label: 'Start dev server',
      action: 'terminal-command',
      command: 'npm run dev',
      appendEnter: false,
      scope: { type: 'global' }
    })
    const advanced = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Advanced')
    )
    const background = document.body.querySelector<HTMLButtonElement>(
      'button[aria-label="Toggle open in background"]'
    )
    const save = document.body.querySelector<HTMLButtonElement>('button[title^="Save ("]')

    expect(background?.className).toContain('focus-visible:ring-[3px]')
    expect(background?.className).toContain('focus-visible:ring-ring/50')
    expect(background?.tabIndex).toBe(0)
    await act(async () => {
      advanced!.click()
    })
    await act(async () => {
      background!.focus()
      background!.click()
    })
    expect(document.body.textContent).not.toContain('Append Enter — run immediately')
    await act(async () => {
      save!.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ openInBackground: true, appendEnter: false })
    )
  })

  it('keeps collapsed advanced controls inert', async () => {
    await renderDialog({
      id: 'qc-1',
      label: 'Status',
      action: 'terminal-command',
      command: 'git status',
      appendEnter: true,
      scope: { type: 'global' }
    })
    const advancedRow = findAnimatedRowContaining('Open in background')
    const advanced = Array.from(document.body.querySelectorAll<HTMLButtonElement>('button')).find(
      (button) => button.textContent?.includes('Advanced')
    )

    expect(advancedRow.inert).toBe(true)
    await act(async () => {
      advanced!.click()
    })
    expect(advancedRow.inert).toBe(false)
  })

  it('hides the background preference for remote-owned commands', async () => {
    await renderDialog(
      {
        id: 'qc-1',
        label: 'Status',
        action: 'terminal-command',
        command: 'git status',
        appendEnter: true,
        scope: { type: 'global' }
      },
      { showBackgroundPreference: false }
    )

    expect(document.body.textContent).not.toContain('Open in background')
  })
})
