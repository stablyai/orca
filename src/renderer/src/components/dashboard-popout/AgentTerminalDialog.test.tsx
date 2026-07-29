// @vitest-environment happy-dom

import '@testing-library/jest-dom/vitest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import type {
  DashboardCard,
  DashboardCardTerminalInput
} from '../../../../shared/dashboard-snapshot'
import { AgentTerminalDialog } from './AgentTerminalDialog'

// Stub the preview so the assertion is on the props the dialog hands it, with
// no xterm / IPC machinery in the way.
vi.mock('./AgentTerminalPreview', () => ({
  AgentTerminalPreview: ({
    ptyId,
    terminalInput
  }: {
    ptyId: string
    terminalInput?: DashboardCardTerminalInput | null
  }) => (
    <div
      data-testid="preview"
      data-pty-id={ptyId}
      data-terminal-input={terminalInput === null ? 'null' : JSON.stringify(terminalInput)}
    />
  )
}))

const TERMINAL_INPUT: DashboardCardTerminalInput = {
  hostPlatform: 'win32',
  localWindowsConpty: true,
  osRelease: '10.0.22631',
  windowsShiftEnterEncoding: 'csi-u',
  kittyKeyboardAdvertised: false
}

function card(overrides: Partial<DashboardCard> = {}): DashboardCard {
  return {
    paneKey: 'tab1:leaf1',
    ptyId: 'pty-1',
    agentType: 'claude',
    bucket: 'working',
    dotState: 'working',
    task: 'task',
    repoId: 'r1',
    worktreeId: 'w1',
    tabId: 'tab1',
    leafId: 'leaf1',
    repoName: 'Repo',
    worktreeName: 'wt',
    startedAt: 0,
    finishedAt: null,
    stateChangedAt: 0,
    unseen: false,
    ...overrides
  }
}

afterEach(() => {
  cleanup()
})

// Why: this is the only seam carrying the relayed host profile into the
// emulator. Dropping the prop degrades every preview to client-OS byte routing
// silently — nothing else in the app reads DashboardCard.terminalInput.
describe('AgentTerminalDialog', () => {
  it("hands the card's relayed host-input profile to the preview terminal", () => {
    render(
      <AgentTerminalDialog
        card={card({ terminalInput: TERMINAL_INPUT })}
        onOpenChange={() => {}}
        onReveal={() => {}}
      />
    )

    expect(screen.getByTestId('preview')).toHaveAttribute(
      'data-terminal-input',
      JSON.stringify(TERMINAL_INPUT)
    )
  })

  it('passes null when the card carries no profile, so the preview routes by client OS', () => {
    render(<AgentTerminalDialog card={card()} onOpenChange={() => {}} onReveal={() => {}} />)

    expect(screen.getByTestId('preview')).toHaveAttribute('data-terminal-input', 'null')
  })
})
