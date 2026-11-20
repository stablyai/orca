// @vitest-environment happy-dom
import { render, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { NativeChatToolRunWindowContext } from '../../tools/runs/native-chat-tool-run-window-context'
import { NativeChatEventRow } from './NativeChatEventRow'

const FIND = {
  on: { isVisible: true, findActive: true },
  off: { isVisible: true, findActive: false }
}

function row(findActive: boolean) {
  return render(
    <NativeChatToolRunWindowContext.Provider value={findActive ? FIND.on : FIND.off}>
      <NativeChatEventRow icon={null} label="Opened 3 pull requests" details={<p>orca#4</p>}>
        Opened 3 pull requests
      </NativeChatEventRow>
    </NativeChatToolRunWindowContext.Provider>
  )
}

it('draws folded details while find has a query, so find can reach them', () => {
  const closed = row(false)
  expect(screen.queryByText('orca#4')).toBeNull()
  closed.unmount()
  row(true)
  expect(screen.getByText('orca#4')).toBeTruthy()
  expect(
    screen.getByRole('button', { name: 'Opened 3 pull requests' }).getAttribute('aria-expanded')
  ).toBe('true')
})

it('names its state for screen readers, since the badge is only drawn', () => {
  render(
    <NativeChatEventRow
      icon={null}
      badge="failed"
      label="Update from Parser"
      details={<p>report</p>}
    >
      Update from Parser
    </NativeChatEventRow>
  )
  expect(screen.getByRole('button', { name: 'Update from Parser, Failed' })).toBeTruthy()
})
