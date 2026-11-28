// @vitest-environment happy-dom
import { expect, it } from 'vitest'
import { openNativeChatSubagent, takeNativeChatSubagentOpener } from './native-chat-open-subagent'

function openFrom(paneKey: string): HTMLButtonElement {
  const opener = document.createElement('button')
  document.body.append(opener)
  opener.focus()
  openNativeChatSubagent(paneKey, 'agent-1')
  return opener
}

it('hands focus back to the opener only while its chat view is still on the page', () => {
  const shown = openFrom('pane-shown')
  expect(takeNativeChatSubagentOpener('pane-shown')).toBe(shown)
  // The chat view holding the opener is released while its sheet stays open.
  openFrom('pane-released').remove()
  expect(takeNativeChatSubagentOpener('pane-released')).toBeUndefined()
  openNativeChatSubagent('pane-shown', null)
  openNativeChatSubagent('pane-released', null)
})
