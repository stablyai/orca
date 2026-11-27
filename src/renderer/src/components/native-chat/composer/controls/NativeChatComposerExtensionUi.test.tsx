// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import type { AgentJournalRenderItem } from '../../../../../../shared/agent-session/journal/agent-session-journal-types'
import {
  AGENT_SESSION_EXTENSION_STATUS_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION,
  AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION,
  agentSessionExtensionStripRows
} from '../../../../../../shared/agent-session/view/agent-session-extension-ui'
import { NativeChatComposerExtensionUi } from './NativeChatComposerExtensionUi'

afterEach(cleanup)

function strip(itemId: string, presentation: string, text: string): AgentJournalRenderItem {
  return {
    itemId,
    revision: 1,
    body: { kind: 'status', text, presentation },
    sequence: 1,
    observedAt: 1,
    turnScope: { kind: 'thread' }
  }
}

it('draws a keyed widget’s lines beside the composer, on the side it asked for', () => {
  const rows = agentSessionExtensionStripRows([
    strip('todos', AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION, '── Todos ──\n[ ] write tests'),
    strip('footer', AGENT_SESSION_EXTENSION_WIDGET_BELOW_PRESENTATION, '3 warnings')
  ])
  render(
    <>
      <div data-testid="above">
        <NativeChatComposerExtensionUi rows={rows} placement="above" />
      </div>
      <div data-testid="below">
        <NativeChatComposerExtensionUi rows={rows} placement="below" />
      </div>
    </>
  )
  const above = screen.getByTestId('above')
  const below = screen.getByTestId('below')

  // Each placement draws its own half, so swapping them would move a panel to the wrong side.
  expect(within(above).getByText(/\[ \] write tests/)).toBeVisible()
  expect(within(above).queryByText('3 warnings')).toBeNull()
  expect(within(below).getByText('3 warnings')).toBeVisible()
  expect(within(below).queryByText(/\[ \] write tests/)).toBeNull()
})

it('holds a placement’s widgets in one bounded stack, so they cannot push the composer away', () => {
  const rows = agentSessionExtensionStripRows(
    [1, 2, 3, 4].map((n) =>
      strip(`panel${n}`, AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION, `panel ${n}\nline two`)
    )
  )
  const { container } = render(<NativeChatComposerExtensionUi rows={rows} placement="above" />)

  const stack = container.querySelector('[data-native-chat-extension-widgets]')
  expect(stack).not.toBeNull()
  for (const n of [1, 2, 3, 4]) {
    expect(stack?.textContent).toContain(`panel ${n}`)
  }
})

it('draws the extension’s status entries as one line above the composer', () => {
  const rows = agentSessionExtensionStripRows([
    strip('lens', AGENT_SESSION_EXTENSION_STATUS_PRESENTATION, 'pi-lens: 3 diagnostics'),
    strip('other', AGENT_SESSION_EXTENSION_STATUS_PRESENTATION, 'Indexing')
  ])
  render(<NativeChatComposerExtensionUi rows={rows} placement="above" />)

  expect(screen.getByText('pi-lens: 3 diagnostics')).toBeVisible()
  expect(screen.getByText('Indexing')).toBeVisible()
})

it('draws nothing once the extension clears everything', () => {
  const rows = agentSessionExtensionStripRows([
    strip('todos', AGENT_SESSION_EXTENSION_WIDGET_PRESENTATION, ''),
    strip('lens', AGENT_SESSION_EXTENSION_STATUS_PRESENTATION, '')
  ])
  const { container } = render(
    <>
      <NativeChatComposerExtensionUi rows={rows} placement="above" />
      <NativeChatComposerExtensionUi rows={rows} placement="below" />
    </>
  )

  expect(container).toBeEmptyDOMElement()
})
