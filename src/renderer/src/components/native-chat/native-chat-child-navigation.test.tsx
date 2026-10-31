// @vitest-environment happy-dom
import '@testing-library/jest-dom/vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NativeChatSubagentEntries } from './NativeChatSubagentRun'
import {
  NativeChatChildNavigationContext,
  useNativeChatChildNavigator
} from './native-chat-child-navigation'

afterEach(cleanup)

function Conversation({ sessionKey }: { sessionKey: string }) {
  const navigator = useNativeChatChildNavigator(sessionKey)
  return (
    <NativeChatChildNavigationContext.Provider value={navigator.navigation}>
      {navigator.child ? (
        <>
          <button onClick={navigator.back}>Back</button>
          <p>{navigator.child.label} history</p>
          <NativeChatSubagentEntries
            agents={[{ id: 'nested', label: 'Nested', state: 'completed' }]}
          />
        </>
      ) : (
        <>
          <p>Parent history</p>
          <NativeChatSubagentEntries
            agents={[{ id: 'child', label: 'Research', state: 'working' }]}
          />
        </>
      )}
    </NativeChatChildNavigationContext.Provider>
  )
}

it('opens even an agent with no loaded inline section and backs through nested conversations', () => {
  render(<Conversation sessionKey="one" />)
  fireEvent.click(screen.getByRole('button', { name: /Research/ }))
  expect(screen.getByText('Research history')).toBeVisible()
  expect(screen.queryByText('Parent history')).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: /Nested/ }))
  expect(screen.getByText('Nested history')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /Nested/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByText('Research history')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  expect(screen.getByText('Parent history')).toBeVisible()
})

it('does not carry a child location to another conversation', () => {
  const view = render(<Conversation sessionKey="one" />)
  fireEvent.click(screen.getByRole('button', { name: /Research/ }))
  view.rerender(<Conversation sessionKey="two" />)
  expect(screen.getByText('Parent history')).toBeVisible()
})
