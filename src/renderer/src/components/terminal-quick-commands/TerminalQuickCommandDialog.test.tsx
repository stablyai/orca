// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { TerminalQuickCommand } from '../../../../shared/terminal-quick-command-types'
import { TerminalQuickCommandDialog } from './TerminalQuickCommandDialog'

const mountedRoots: Root[] = []

async function renderDialog(
  command: TerminalQuickCommand,
  props: { defaultAdvancedOpen?: boolean } = {}
): Promise<void> {
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
        defaultAdvancedOpen={props.defaultAdvancedOpen}
        onOpenChange={vi.fn()}
        onSave={vi.fn()}
      />
    )
  })
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
})
