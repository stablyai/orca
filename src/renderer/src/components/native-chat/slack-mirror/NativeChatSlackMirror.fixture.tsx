import { defineFixture } from '../../../component-fixtures/component-fixture'
import type { ReactNode } from 'react'
import type { ExternalConversationLink } from '../../../../../shared/connectors/external-conversation-link'
import {
  NativeChatSlackMirrorContext,
  type NativeChatSlackMirror
} from './native-chat-slack-mirror'
import { NativeChatSlackMirrorItem } from './NativeChatSlackMirrorItem'
import {
  NativeChatSlackMirrorPostLine,
  NativeChatSlackMirrorTag
} from './NativeChatSlackMirrorPost'

const link = (fields: Partial<ExternalConversationLink>): ExternalConversationLink => ({
  source: 'slack',
  externalId: 'T1:C9:1792.9:U5',
  sessionId: 's',
  agent: 'claude',
  paneKey: 'chat:s',
  bot: { kind: 'bot', botId: 'atlas' },
  place: '#eng',
  opener: { role: 'member', name: 'Sam Lee' },
  mirror: true,
  createdAt: 1,
  ...fields
})

function mirror(fields: Partial<ExternalConversationLink>): NativeChatSlackMirror {
  return {
    bot: () => null,
    botName: 'Atlas',
    sessionId: 's',
    link: link(fields),
    anyPosted: true,
    setOn: async () => true,
    post: async () => true,
    status: async () => ({ channelName: '#eng', customize: true })
  }
}

function Frame({ value, children }: { value: NativeChatSlackMirror; children: ReactNode }) {
  return (
    <NativeChatSlackMirrorContext.Provider value={value}>
      <div className="native-chat-appearance @container flex flex-col items-end gap-3 bg-background p-4 text-2xs text-chat-foreground-faint">
        {children}
      </div>
    </NativeChatSlackMirrorContext.Provider>
  )
}

const ITEM = 'orca:send-1'

export const on = defineFixture({
  width: 520,
  render: () => (
    <Frame value={mirror({ mirrorPosts: { [ITEM]: { state: 'posted', at: 1 } } })}>
      <NativeChatSlackMirrorTag />
      <NativeChatSlackMirrorPostLine itemId="x" post={{ state: 'posting', at: 1 }} />
      <NativeChatSlackMirrorPostLine
        itemId="y"
        post={{ state: 'failed', at: 1, error: 'transient' }}
      />
      <div className="flex w-full">
        <NativeChatSlackMirrorItem />
      </div>
    </Frame>
  )
})

export const off = defineFixture({
  width: 520,
  render: () => (
    <Frame value={mirror({ mirror: false })}>
      <div className="flex w-full">
        <NativeChatSlackMirrorItem />
      </div>
    </Frame>
  )
})

export const menu = defineFixture({
  width: 520,
  render: () => (
    <Frame value={mirror({})}>
      <div className="flex w-full pt-48">
        <NativeChatSlackMirrorItem />
      </div>
    </Frame>
  ),
  interact: async (frame) => {
    const trigger = frame.querySelector<HTMLButtonElement>('button[aria-haspopup="menu"]')
    trigger?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
    await new Promise((resolve) => setTimeout(resolve, 200))
  }
})
