// @vitest-environment happy-dom
import { entry, root } from './agent-launch-setup-panel-test-fixture'
import { act } from 'react'
import { fireEvent, queryByRole, getByRole } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { AgentLaunchPickerMenu } from './AgentLaunchPickerMenu'
import { AgentLaunchResumeSessionContext } from './agent-launch-resume-session'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger
} from '@/components/ui/dropdown-menu'
import type { TuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent'

function openSetup(resume: ((agent: TuiAgent) => void) | null): void {
  act(() =>
    root.render(
      <TooltipProvider>
        <AgentLaunchResumeSessionContext value={resume}>
          <DropdownMenu defaultOpen modal={false}>
            <DropdownMenuTrigger>New tab</DropdownMenuTrigger>
            <DropdownMenuContent>
              <AgentLaunchPickerMenu entries={[entry]} runLaunch={vi.fn()} />
            </DropdownMenuContent>
          </DropdownMenu>
        </AgentLaunchResumeSessionContext>
      </TooltipProvider>
    )
  )
  fireEvent.click(
    document.querySelector<HTMLButtonElement>('button[aria-label="Configure Claude"]')!
  )
}

it("offers the agent's earlier sessions only where the launch menu can open them", () => {
  openSetup(null)
  expect(queryByRole(document.body, 'button', { name: 'Resume session…' })).toBeNull()

  const resume = vi.fn()
  openSetup(resume)
  fireEvent.click(getByRole(document.body, 'button', { name: 'Resume session…' }))
  expect(resume).toHaveBeenCalledWith('claude')
})
