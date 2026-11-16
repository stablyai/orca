// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { NativeChatToolRun } from './NativeChatToolRun'
import {
  NativeChatDisclosureContext,
  useNativeChatDisclosures
} from '../../messages/disclosure/native-chat-disclosure-store'

function Transcript({
  expanded,
  id = 'first'
}: {
  expanded: boolean
  id?: string | null
}): React.JSX.Element {
  const disclosures = useNativeChatDisclosures()
  return (
    <NativeChatDisclosureContext.Provider value={disclosures}>
      {id ? (
        <NativeChatToolRun
          disclosureId={id}
          expandSignal={expanded}
          activeTurnIsWorking
          blocks={[
            { type: 'tool-call', callId: 'read', name: 'Read', input: { file_path: 'README.md' } }
          ]}
        />
      ) : null}
    </NativeChatDisclosureContext.Provider>
  )
}

vi.mock('../tasks/NativeChatBackgroundTaskRun', () => ({ NativeChatBackgroundTaskRun: () => null }))
vi.mock('../../subagents/NativeChatSubagentRun', () => ({ NativeChatSubagentRun: () => null }))
vi.mock('./NativeChatBrowserPageButton', () => ({ NativeChatBrowserRunPageButton: () => null }))
vi.mock('../../media/images/NativeChatImageAttachments', () => ({
  NativeChatImageAttachments: () => null
}))
vi.mock('./NativeChatToolRunMemberList', () => ({ NativeChatToolRunMemberList: () => null }))

afterEach(cleanup)

it('keeps a reader collapse across default changes and row recycling, while new runs open', () => {
  const view = render(<Transcript expanded={false} />)
  const header = () => view.container.querySelector('[data-native-chat-tool-run-state]')!
  expect(header()).toHaveAttribute('aria-expanded', 'false')
  fireEvent.click(header())
  expect(header()).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(header())
  view.rerender(<Transcript expanded />)
  expect(header()).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<Transcript expanded={false} />)
  expect(header()).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<Transcript expanded />)
  expect(header()).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<Transcript expanded id={null} />)
  view.rerender(<Transcript expanded />)
  expect(header()).toHaveAttribute('aria-expanded', 'false')
  view.rerender(<Transcript expanded id="second" />)
  expect(header()).toHaveAttribute('aria-expanded', 'true')
  fireEvent.click(header())
  view.rerender(<Transcript expanded id="first" />)
  expect(header()).toHaveAttribute('aria-expanded', 'false')
})
