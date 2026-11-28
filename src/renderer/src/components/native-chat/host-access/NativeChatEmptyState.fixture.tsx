import { defineFixture } from '../../../component-fixtures/component-fixture'
import { useAppStore } from '../../../store'
import { BotAvatarTile } from '../../bots/BotAvatar'
import { useNativeChatAppearanceStyle } from '../appearance/native-chat-appearance-style'
import { NativeChatComposer } from '../composer/NativeChatComposer'
import { NativeChatContextClearFade } from '../conversation/projection/NativeChatContextClearFade'
import { NativeChatEmptyState } from './NativeChatEmptyState'

const LONG_PURPOSE =
  'Investigates product issues, reviews changes, checks release readiness, and helps the team ship reliable software. It explains what changed, verifies the result, and keeps the work moving across local folders, remote hosts, and every supported platform.'

function WelcomePane({
  purpose,
  height,
  withIcon = true
}: {
  purpose: string
  height: number
  withIcon?: boolean
}) {
  const settings = useAppStore((state) => state.settings)
  const appearance = useNativeChatAppearanceStyle(settings)
  return (
    <div
      data-welcome-fixture
      className="native-chat-appearance bg-chat-canvas flex min-h-0 w-full flex-col overflow-hidden"
      style={{ ...appearance, height }}
    >
      <div className="relative flex min-h-0 flex-1 flex-col">
        <NativeChatContextClearFade clearing={false}>
          <NativeChatEmptyState
            kind="empty"
            agent="antigravity"
            persona={{
              name: 'Layout Bot',
              subtitle: purpose,
              icon: withIcon ? (
                <BotAvatarTile src={null} fallback="L" className="size-14 rounded-xl text-xl" />
              ) : null
            }}
          />
        </NativeChatContextClearFade>
      </div>
      <NativeChatComposer
        terminalTabId="fixture-welcome"
        paneKey="fixture-welcome"
        targetPtyId="fixture-welcome"
        agent="antigravity"
      />
    </div>
  )
}

const pane = (width: number, height: number, purpose: string, withIcon = true) =>
  defineFixture({
    width: width + 32,
    render: () => <WelcomePane purpose={purpose} height={height} withIcon={withIcon} />
  })

export const longPurpose = pane(817, 225, LONG_PURPOSE)
export const shortPurpose = pane(817, 225, 'Helps the team ship reliable software.')
export const emptyPurpose = pane(817, 225, '')
export const ordinary = pane(817, 600, LONG_PURPOSE)
export const narrow = pane(260, 225, LONG_PURPOSE)
export const minimumTerminalSplit = pane(50, 600, LONG_PURPOSE)
export const noIcon = pane(817, 225, LONG_PURPOSE, false)
