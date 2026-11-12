import { useState } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatWorkingStatus } from './NativeChatWorkingStatus'
import { NativeChatSessionSpeedButton } from '../../session/options/controls/NativeChatSessionSpeedButton'

function OmpTurn() {
  const [tier, setTier] = useState('priority')
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="native-chat-appearance flex flex-col gap-5 p-4">
      <p className="text-sm text-chat-foreground">The requested changes are ready.</p>
      <NativeChatWorkingStatus
        startedAt={1_000}
        workedSeconds={30}
        verdict="success"
        tokensPerSecond={42}
        expanded={expanded}
        onToggleExpanded={() => setExpanded(!expanded)}
      />
      <div className="flex items-center justify-end gap-2">
        <NativeChatSessionSpeedButton
          label="Speed"
          standard={{ value: 'default', label: 'Standard' }}
          tiers={[{ value: 'priority', label: 'Fast' }]}
          current={tier}
          disabled={false}
          onSet={(value) => setTier(String(value))}
        />
      </div>
    </div>
  )
}

export const omp = defineFixture({ width: 560, render: () => <OmpTurn /> })
export const narrow = defineFixture({ width: 320, render: () => <OmpTurn /> })
