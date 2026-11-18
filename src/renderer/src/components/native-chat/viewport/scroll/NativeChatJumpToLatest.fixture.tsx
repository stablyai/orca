import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatJumpToLatest } from './NativeChatJumpToLatest'

const PROSE = [
  'The reconnect path retries the relay handshake before it replays buffered output, so a stalled socket shows up as a slow first frame rather than a dropped session.',
  'I traced the stall to the worktree sync: it waits for the remote index lock, and the lock holder is the previous connection that never released it after the laptop slept.',
  'Releasing the lock on disconnect fixes the overnight case. The remaining risk is a second client attaching during the grace window, which the lease check already rejects.',
  'Next I will run the remote suite against a paired Linux host and confirm the replay order matches the local transcript.'
]

function Transcript(): React.JSX.Element {
  return (
    <div className="native-chat-appearance relative h-56 overflow-hidden bg-chat-canvas px-4 pt-3 text-sm text-chat-foreground">
      <div className="space-y-3">
        {PROSE.map((paragraph) => (
          <p key={paragraph}>{paragraph}</p>
        ))}
      </div>
      <NativeChatJumpToLatest visible onJump={() => {}} />
    </div>
  )
}

export const overTranscript = defineFixture({ width: 640, render: () => <Transcript /> })

export const narrow = defineFixture({ width: 360, render: () => <Transcript /> })
