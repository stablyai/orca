// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import type React from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Automation } from '../../../../shared/automations-types'
import { i18n } from '@/i18n/i18n'
import { AutomationDetail } from './AutomationDetail'
import { AutomationPromptDisclosure } from './AutomationPromptDisclosure'

vi.mock('@/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>
}))

let promptNaturalHeight = 0
let resizeCallback: ResizeObserverCallback | null = null

class PromptResizeObserver implements ResizeObserver {
  constructor(callback: ResizeObserverCallback) {
    resizeCallback = callback
  }

  disconnect(): void {}
  observe(): void {}
  unobserve(): void {}
}

function makeAutomation(
  updatedAt: number,
  prompt = `Synthetic opening.\n${'Synthetic detail. '.repeat(80)}`
): Automation {
  return {
    id: 'synthetic-automation',
    name: 'Synthetic automation',
    prompt,
    precheck: null,
    agentId: 'codex',
    projectId: 'synthetic-project',
    executionTargetType: 'local',
    executionTargetId: 'local',
    schedulerOwner: 'local_host_service',
    workspaceMode: 'existing',
    workspaceId: 'synthetic-workspace',
    baseBranch: null,
    reuseSession: false,
    timezone: 'UTC',
    rrule: 'FREQ=DAILY',
    dtstart: 1,
    enabled: false,
    nextRunAt: 2,
    missedRunPolicy: 'run_once_within_grace',
    missedRunGraceMinutes: 720,
    createdAt: 1,
    updatedAt
  }
}

const detailCallbacks = {
  onRunNow: vi.fn(),
  onEdit: vi.fn(),
  onToggle: vi.fn(),
  onDelete: vi.fn()
}

describe('AutomationPromptDisclosure', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en')
    vi.stubGlobal('ResizeObserver', PromptResizeObserver)
    vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        if (this.tagName !== 'P') {
          return 0
        }
        return this.classList.contains('line-clamp-4')
          ? Math.min(promptNaturalHeight, 80)
          : promptNaturalHeight
      }
    )
    vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.tagName === 'P' ? promptNaturalHeight : 0
      }
    )
  })

  afterEach(async () => {
    cleanup()
    resizeCallback = null
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    await i18n.changeLanguage('en')
  })

  it('leaves a short prompt fully readable without a disclosure control', () => {
    promptNaturalHeight = 40
    render(<AutomationPromptDisclosure prompt="Synthetic short prompt." />)

    expect(screen.getByText('Synthetic short prompt.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
  })

  it('labels the prompt correctly in Spanish', async () => {
    promptNaturalHeight = 40
    await i18n.changeLanguage('es')
    render(<AutomationPromptDisclosure prompt="Synthetic short prompt." />)

    expect(screen.getByText('Prompt')).toBeVisible()
    expect(screen.queryByText('Inmediato')).not.toBeInTheDocument()
  })

  it('reveals the complete long prompt from the keyboard and keeps it selectable', async () => {
    promptNaturalHeight = 240
    const prompt = `Synthetic opening.\n${'Synthetic detail. '.repeat(80)}\nSYNTHETIC-END-MARKER`
    const user = userEvent.setup()
    render(<AutomationPromptDisclosure prompt={prompt} />)

    const content = screen.getByText(/SYNTHETIC-END-MARKER/)
    const toggle = screen.getByRole('button', { name: 'Show more' })
    expect(screen.getAllByText('Prompt')).toHaveLength(1)
    expect(content).toHaveClass('line-clamp-4', 'select-text', '[overflow-wrap:anywhere]')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    expect(toggle).toHaveAttribute('aria-controls', content.id)
    expect(toggle).toHaveAttribute('data-variant', 'ghost')
    expect(toggle).toHaveAttribute('data-size', 'xs')
    expect(toggle).not.toHaveClass('h-auto', 'p-0')

    await user.tab()
    expect(toggle).toHaveFocus()
    await user.keyboard('{Enter}')

    expect(screen.getByRole('button', { name: 'Show less' })).toHaveAttribute(
      'aria-expanded',
      'true'
    )
    expect(content).not.toHaveClass('line-clamp-4')
    expect(content).toHaveTextContent('SYNTHETIC-END-MARKER')

    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveAttribute(
      'aria-expanded',
      'false'
    )
    expect(content).toHaveClass('line-clamp-4')

    await user.click(screen.getByRole('button', { name: 'Show more' }))
    act(() => resizeCallback?.([], {} as ResizeObserver))
    expect(screen.getByRole('button', { name: 'Show less' })).toHaveFocus()

    await user.click(screen.getByRole('button', { name: 'Show less' }))
    expect(screen.getByRole('button', { name: 'Show more' })).toHaveFocus()
    expect(content).toHaveClass('line-clamp-4')
  })

  it('offers disclosure after a narrow resize makes the prompt overflow', () => {
    promptNaturalHeight = 60
    render(<AutomationPromptDisclosure prompt="Synthetic prompt that reflows at narrow widths." />)
    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()

    promptNaturalHeight = 180
    act(() => resizeCallback?.([], {} as ResizeObserver))

    expect(screen.getByRole('button', { name: 'Show more' })).toBeVisible()
  })

  it('moves focus to the fully visible prompt when resizing removes the disclosure', () => {
    promptNaturalHeight = 180
    render(<AutomationPromptDisclosure prompt="Synthetic prompt that fits after widening." />)
    const content = screen.getByText('Synthetic prompt that fits after widening.')
    screen.getByRole('button', { name: 'Show more' }).focus()

    promptNaturalHeight = 60
    act(() => resizeCallback?.([], {} as ResizeObserver))

    expect(screen.queryByRole('button', { name: 'Show more' })).not.toBeInTheDocument()
    expect(content).toHaveFocus()
  })

  it('preserves expansion and focus across unrelated automation updates', async () => {
    promptNaturalHeight = 240
    const user = userEvent.setup()
    const { rerender } = render(
      <AutomationDetail
        automation={makeAutomation(1)}
        runs={[]}
        projectName="Synthetic project"
        workspaceName="Synthetic workspace"
        projectDefaultBaseRef={null}
        runNowAvailability={null}
        now={1}
        {...detailCallbacks}
      />
    )

    await user.click(screen.getByRole('button', { name: 'Show more' }))
    const showLess = screen.getByRole('button', { name: 'Show less' })
    showLess.focus()

    rerender(
      <AutomationDetail
        automation={makeAutomation(2)}
        runs={[]}
        projectName="Synthetic project"
        workspaceName="Synthetic workspace"
        projectDefaultBaseRef={null}
        runNowAvailability={null}
        now={2}
        {...detailCallbacks}
      />
    )

    expect(screen.getByRole('button', { name: 'Show less' })).toHaveFocus()

    promptNaturalHeight = 40
    rerender(
      <AutomationDetail
        automation={makeAutomation(3, 'Synthetic replacement prompt.')}
        runs={[]}
        projectName="Synthetic project"
        workspaceName="Synthetic workspace"
        projectDefaultBaseRef={null}
        runNowAvailability={null}
        now={3}
        {...detailCallbacks}
      />
    )

    expect(screen.getByText('Synthetic replacement prompt.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Show less' })).not.toBeInTheDocument()
  })
})
