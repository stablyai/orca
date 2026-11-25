// @vitest-environment happy-dom
// A share request's row opens its page as the main column's view, in place of the open workspace and
// its tabs (which would otherwise cover it), so its Accept can be pressed.
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { useAppStore } from '@/store/index'
import { useAppChromeLayout } from '@/app-shell/chrome/use-app-chrome-layout'
import { installSharedBotHostCatalog } from '@/runtime/hosts/shared-bot-hosts/shared-bot-host-catalog'
import type { SharedBotHostsState } from '../../../../../shared/bots/shared-bot-hosts'
import { SharedBotRequestPageMount } from './SharedBotRequestPage'
import { SharedBotRequestRows } from './SharedBotRequestRows'

const initial = useAppStore.getState()
const accept = vi.fn(async () => true)
let stopCatalog: () => void = () => {}

const offered: SharedBotHostsState = {
  sharing: true,
  hosts: [],
  requests: [{ shareId: 'share-ivy', botId: 'ivy', botName: 'Ivy', ownerName: 'Jinwoo Hong' }]
}

// The shell's main column, as AppWorkspaceShell lays it out: the workspace's tabs while the layout
// shows the workbench, and the request page as its view.
function Shell(): React.JSX.Element {
  const layout = useAppChromeLayout()
  return (
    <TooltipProvider>
      <SharedBotRequestRows />
      {layout.terminalWorkbenchVisible ? <div data-testid="tab-pane" /> : null}
      {layout.activeView === 'shareRequest' ? <SharedBotRequestPageMount /> : null}
    </TooltipProvider>
  )
}

beforeEach(async () => {
  useAppStore.setState(initial, true)
  // A workspace is open, with its tab showing.
  useAppStore.setState({ activeView: 'terminal', activeWorktreeId: 'wt-1' })
  vi.stubGlobal('api', {
    ...window.api,
    sharedBotHosts: {
      onChanged: () => () => {},
      list: async () => offered,
      accept,
      decline: vi.fn(async () => true)
    }
  })
  stopCatalog = installSharedBotHostCatalog()
  await act(async () => {})
})

afterEach(() => {
  cleanup()
  stopCatalog()
  vi.unstubAllGlobals()
  useAppStore.setState(initial, true)
})

it('opens as the view over an open tab, and its Accept answers', async () => {
  render(<Shell />)
  expect(screen.getByTestId('tab-pane')).toBeTruthy()

  fireEvent.click(screen.getByText('Jinwoo shared Ivy with you'))

  expect(useAppStore.getState().activeView).toBe('shareRequest')
  expect(screen.queryByTestId('tab-pane')).toBeNull()
  const accepts = screen.getAllByRole('button', { name: 'Accept' })
  // The row's and the page's; the page's is the last.
  await act(async () => fireEvent.click(accepts.at(-1)!))
  expect(accept).toHaveBeenCalledWith({ shareId: 'share-ivy' })
})

it('goes back to the workspace on Esc', () => {
  render(<Shell />)
  fireEvent.click(screen.getByText('Jinwoo shared Ivy with you'))
  fireEvent.keyDown(document.body, { key: 'Escape' })
  expect(useAppStore.getState().activeView).toBe('terminal')
})
