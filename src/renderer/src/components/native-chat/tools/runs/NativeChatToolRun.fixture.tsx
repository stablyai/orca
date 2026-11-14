import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatMessageList } from '../../NativeChatMessageList'
import type { NativeChatLiveSession } from '../../session/terminal/read/native-chat-live-session-contract'
import { SettingsSwitchRow } from '../../../settings/form-controls/SettingsFormControls'
import { Button } from '../../../ui/button'

const session: NativeChatLiveSession = {
  agent: 'codex',
  sessionId: 'auto-expand-tools-fixture',
  status: 'working',
  readPhase: 'ready',
  hasMore: false,
  loadingEarlier: false,
  olderHistoryGeneration: 0,
  loadEarlier: async () => 'applied',
  messages: [
    {
      id: 'prompt',
      role: 'user',
      source: 'transcript',
      timestamp: 1800000000000,
      blocks: [{ type: 'text', text: 'Check the build and watch its output.' }]
    },
    {
      id: 'run',
      role: 'assistant',
      source: 'transcript',
      timestamp: 1800000001000,
      blocks: [
        {
          type: 'tool-call',
          name: 'exec_command',
          callId: 'build',
          state: 'running',
          input: { cmd: 'pnpm build' }
        },
        {
          type: 'tool-result',
          callId: 'build',
          output: 'Building renderer…\nTransforming modules…'
        }
      ]
    }
  ]
}

function LiveTranscript({ initialExpanded = false }: { initialExpanded?: boolean }) {
  const [expanded, setExpanded] = useState(initialExpanded)
  const [working, setWorking] = useState(true)
  return (
    <div className="flex h-[500px] flex-col gap-3 p-4">
      <SettingsSwitchRow
        label="Auto expand tools"
        checked={expanded}
        ariaLabel="Auto expand tools"
        onChange={() => setExpanded(!expanded)}
      />
      <Button variant="outline" onClick={() => setWorking(false)}>
        Finish fixture turn
      </Button>
      <NativeChatMessageList
        session={{ ...session, status: working ? 'working' : 'ready' }}
        isWorking={working}
        expandSignal={expanded}
      />
    </div>
  )
}

export const off = defineFixture({ width: 680, render: () => <LiveTranscript /> })
export const on = defineFixture({ width: 680, render: () => <LiveTranscript initialExpanded /> })
export const manuallyCollapsed = defineFixture({
  width: 680,
  render: () => <LiveTranscript initialExpanded />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('[data-native-chat-tool-run-state]')?.click()
  }
})
export const finished = defineFixture({
  width: 680,
  render: () => <LiveTranscript initialExpanded />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button:not([role="switch"])')?.click()
  }
})
