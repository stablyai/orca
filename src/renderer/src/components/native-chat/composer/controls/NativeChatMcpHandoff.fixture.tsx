import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from './NativeChatComposerNotices'
import { nativeChatMcpHandoffNotice } from './native-chat-mcp-handoff-notice'
import { NativeChatComposer } from '../NativeChatComposer'
import { writeNativeChatDraftCache } from '../../drafts/native-chat-draft-views'

function McpComposer() {
  const [terminal, setTerminal] = useState(false)
  return (
    <div className="native-chat-appearance bg-background p-4">
      <NativeChatComposer
        terminalTabId="mcp-fixture-tab"
        paneKey="mcp-fixture-pane"
        targetPtyId="remote:fixture@@pty"
        agent="claude"
        onSwitchToTerminal={() => setTerminal(true)}
      />
      {terminal ? (
        <output className="block pt-3 text-sm text-chat-foreground">
          Fixture terminal opened; terminal input unchanged
        </output>
      ) : null}
    </div>
  )
}

function McpHandoff({ structured, remote }: { structured: boolean; remote: boolean }) {
  const [opened, setOpened] = useState(false)
  return (
    <div className="native-chat-appearance space-y-3 bg-background p-4">
      <NativeChatComposerNotices
        notices={[
          nativeChatMcpHandoffNotice({
            structured,
            remote,
            pending: false,
            open: () => setOpened(true)
          })
        ]}
      />
      <output className="block text-sm text-chat-foreground" aria-label="Fixture outcome">
        {opened ? 'Terminal handoff requested' : 'Chat draft: /mcp'}
      </output>
    </div>
  )
}

export const structuredRemote = defineFixture({
  width: 720,
  render: () => <McpHandoff structured remote />
})

export const terminalLocal = defineFixture({
  width: 720,
  render: () => <McpHandoff structured={false} remote={false} />
})

export const narrowRemote = defineFixture({
  width: 360,
  render: () => <McpHandoff structured remote />
})

export const terminalAction = defineFixture({
  ...terminalLocal,
  interact: (frame) => {
    const button = frame.querySelector<HTMLButtonElement>('button')
    if (!button) {
      throw new Error('MCP terminal action is missing')
    }
    button.click()
  }
})

export const composer = defineFixture({
  width: 720,
  setup: () => writeNativeChatDraftCache('mcp-fixture-pane', '/mcp'),
  render: () => <McpComposer />
})
