// @vitest-environment happy-dom

import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it, vi } from 'vitest'
import CloseTerminalDialog, { type CloseTerminalDialogTerminal } from './CloseTerminalDialog'
import { translate } from '@/i18n/i18n'

vi.mock('@/i18n/i18n', () => ({
  translate: vi.fn(
    (_key: string, fallback: string, options?: { count?: number; defaultValue_one?: string }) => {
      if (options?.count === undefined) {
        return fallback
      }
      // Why: mirrors i18next picking the `_one` default for a count of 1.
      const text =
        options.count === 1 && options.defaultValue_one ? options.defaultValue_one : fallback
      return text.replace('{{count}}', String(options.count))
    }
  )
}))

const mountedRoots: Root[] = []

const GROUP_TERMINALS: CloseTerminalDialogTerminal[] = [
  { key: 'build', label: 'Build server', copyKind: 'command' },
  { key: 'agent', label: 'Claude fixing a long-running deployment issue', copyKind: 'agent' },
  { key: 'tests', label: 'Test watcher', copyKind: 'command' }
]

async function renderDialog(props: {
  copyKind?: 'command' | 'agent'
  tabLabel?: string
  subjectKey?: string
  terminals?: CloseTerminalDialogTerminal[]
  onConfirm: (dontAskAgain: boolean) => void
  onCancel?: () => void
}): Promise<Root> {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  mountedRoots.push(root)

  await act(async () => {
    root.render(<CloseTerminalDialog open {...props} onCancel={props.onCancel ?? vi.fn()} />)
  })
  return root
}

function clickButton(label: string): void {
  const button = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
    (candidate) => candidate.textContent === label
  )
  if (!button) {
    throw new Error(`Button not found: ${label}`)
  }
  button.click()
}

describe('CloseTerminalDialog', () => {
  afterEach(async () => {
    await act(async () => {
      for (const root of mountedRoots.splice(0)) {
        root.unmount()
      }
    })
    document.body.innerHTML = ''
  })

  it('does no dialog-copy work while closed, then builds the opened confirmation', async () => {
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)
    const props = { onCancel: vi.fn(), onConfirm: vi.fn() }
    vi.mocked(translate).mockClear()

    await act(async () => root.render(<CloseTerminalDialog open={false} {...props} />))
    expect(translate).not.toHaveBeenCalled()

    await act(async () => root.render(<CloseTerminalDialog open {...props} />))
    expect(document.body.textContent).toContain('Stop running command?')
    expect(translate).toHaveBeenCalled()
  })

  it('renders running command copy and confirms without skipping by default', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'command', onConfirm })

    expect(document.body.textContent).toContain('Stop running command?')
    expect(document.body.textContent).toContain(
      'Closing this terminal will stop the command running inside it.'
    )

    await act(async () => {
      clickButton('Stop and Close')
    })

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('renders agent copy and passes the skip preference when checked', async () => {
    const onConfirm = vi.fn()

    await renderDialog({ copyKind: 'agent', onConfirm })

    expect(document.body.textContent).toContain('Stop this agent?')
    expect(document.body.textContent).toContain(
      "Closing this terminal will stop the agent's current work."
    )

    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
    expect(checkbox).not.toBeNull()

    await act(async () => {
      checkbox?.click()
    })
    await act(async () => {
      clickButton('Stop Agent')
    })

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('resets the skip preference when the dialog closes and reopens', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const container = document.createElement('div')
    document.body.appendChild(container)
    const root = createRoot(container)
    mountedRoots.push(root)
    const render = async (open: boolean): Promise<void> => {
      await act(async () => {
        root.render(<CloseTerminalDialog open={open} onCancel={onCancel} onConfirm={onConfirm} />)
      })
    }

    await render(true)
    const checkbox = document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')
    await act(async () => {
      checkbox?.click()
    })
    expect(checkbox?.getAttribute('aria-checked')).toBe('true')

    await render(false)
    await render(true)

    expect(document.body.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
      'false'
    )
  })

  it('reveals grouped terminals with agent markers and retains the skip preference', async () => {
    const onConfirm = vi.fn()
    await renderDialog({
      copyKind: 'agent',
      tabLabel: 'Deployment',
      subjectKey: 'tab-cluster:deployment',
      terminals: GROUP_TERMINALS,
      onConfirm
    })

    expect(document.body.textContent).toContain('Stop these agents?')
    expect(document.body.textContent).toContain('Closing this group will stop 3 running terminals.')
    expect(document.body.textContent).toContain('Deployment')
    expect(document.body.textContent).toContain(
      'This terminal will not resume automatically. Cancel and put the workspace to sleep to resume it later.'
    )
    expect(document.activeElement?.textContent).toBe('Stop Agent')
    expect(document.body.querySelector('[role="list"]')).toBeNull()
    for (const terminal of GROUP_TERMINALS) {
      expect(document.body.textContent).not.toContain(terminal.label)
    }
    expect(
      document.body
        .querySelector('[data-slot="collapsible-trigger"]')
        ?.getAttribute('aria-expanded')
    ).toBe('false')

    await act(async () => clickButton('Show 3 running terminals'))

    expect(
      document.body
        .querySelector('[data-slot="collapsible-trigger"]')
        ?.getAttribute('aria-expanded')
    ).toBe('true')
    const rows = [...document.body.querySelectorAll('[role="list"] li')]
    expect(rows.map((row) => row.textContent)).toEqual([
      'Build server',
      'Claude fixing a long-running deployment issueAgent',
      'Test watcher'
    ])
    expect(rows.map((row) => row.querySelector('[title]')?.getAttribute('title'))).toEqual(
      GROUP_TERMINALS.map((terminal) => terminal.label)
    )
    const scrollRegion = document.body.querySelector<HTMLElement>(
      '[role="region"][aria-label="Running terminals"]'
    )
    expect(scrollRegion?.tabIndex).toBe(0)

    await act(async () => clickButton('Hide running terminals'))
    expect(document.body.querySelector('[role="list"]')).toBeNull()

    await act(async () => {
      document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
    })
    await act(async () => clickButton('Stop Agent'))

    expect(onConfirm).toHaveBeenCalledWith(true)
  })

  it('uses plural command copy and an unnamed-group fallback without changing the confirm label', async () => {
    const onConfirm = vi.fn()
    await renderDialog({
      terminals: GROUP_TERMINALS.map<CloseTerminalDialogTerminal>((terminal) => ({
        ...terminal,
        copyKind: 'command'
      })),
      tabLabel: '',
      onConfirm
    })

    expect(document.body.textContent).toContain('Stop running commands?')
    expect(document.body.textContent).toContain('Closing this group will stop 3 running terminals.')
    expect(document.body.textContent).toContain('Unnamed group')
    expect(document.body.textContent).not.toContain('This terminal will not resume automatically.')

    await act(async () => clickButton('Stop and Close'))

    expect(onConfirm).toHaveBeenCalledWith(false)
  })

  it('uses singular copy when only one group member is running', async () => {
    await renderDialog({
      terminals: [{ ...GROUP_TERMINALS[0]!, copyKind: 'command' }],
      tabLabel: 'Backend',
      onConfirm: vi.fn()
    })

    expect(document.body.textContent).toContain('Closing this group will stop 1 running terminal.')
    expect(document.body.textContent).toContain('Show 1 running terminal')
    expect(document.body.textContent).not.toContain('1 running terminals')
  })

  it('collapses the terminal list and clears the skip preference on reopen or subject change', async () => {
    const onConfirm = vi.fn()
    const onCancel = vi.fn()
    const props = {
      copyKind: 'agent',
      terminals: GROUP_TERMINALS,
      onCancel,
      onConfirm
    } satisfies Omit<React.ComponentProps<typeof CloseTerminalDialog>, 'open'>
    const root = await renderDialog({
      ...props,
      subjectKey: 'tab-cluster:deployment',
      tabLabel: 'Deployment'
    })
    const render = async (open: boolean, subjectKey?: string): Promise<void> => {
      await act(async () => {
        root.render(
          <CloseTerminalDialog
            open={open}
            subjectKey={subjectKey}
            tabLabel="Deployment"
            {...props}
          />
        )
      })
    }
    const expandAndCheck = async (): Promise<void> => {
      await act(async () => clickButton('Show 3 running terminals'))
      await act(async () => {
        document.body.querySelector<HTMLButtonElement>('[role="checkbox"]')?.click()
      })
      expect(document.body.querySelector('[role="list"]')).not.toBeNull()
      expect(document.body.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
        'true'
      )
    }
    const expectReset = (): void => {
      expect(
        document.body
          .querySelector('[data-slot="collapsible-trigger"]')
          ?.getAttribute('aria-expanded')
      ).toBe('false')
      expect(document.body.querySelector('[role="list"]')).toBeNull()
      expect(document.body.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe(
        'false'
      )
    }

    await expandAndCheck()
    await render(false)
    await render(true, 'tab-cluster:deployment')
    expectReset()

    await expandAndCheck()
    await render(true, 'tab-cluster:monitoring')
    expectReset()
  })
})
