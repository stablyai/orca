// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../shared/types'
import { TerminalQuickCommandDialog } from './TerminalQuickCommandDialog'

globalThis.IS_REACT_ACT_ENVIRONMENT = true

const mountedRoots: Root[] = []

async function renderDialog(
  command: TerminalQuickCommand,
  onSave = vi.fn()
): Promise<{ onSave: ReturnType<typeof vi.fn> }> {
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
    const promptHelpRow = findAnimatedRowContaining('Supports skills')

    expect(agentRow.getAttribute('aria-hidden')).toBe('true')
    expect(agentRow.className).toContain('transition-[grid-template-rows]')
    expect(agentRow.className).toContain('grid-rows-[0fr]')
    expect(promptHelpRow.getAttribute('aria-hidden')).toBe('true')
    expect(promptHelpRow.className).toContain('grid-rows-[0fr]')
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
    const advanced = Array.from(document.body.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Advanced'
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
      background!.click()
    })
    await act(async () => {
      save!.click()
    })

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({ openInBackground: true, action: 'agent-prompt' })
    )
  })
})
