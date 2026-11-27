// @vitest-environment happy-dom
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createRef } from 'react'
import { cleanup, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { BotGroupTurn as Turn } from '../../../../shared/bots/bot-group'
import { BotGroupTurn } from './BotGroupTurn'
import { BotGroupTranscriptRows } from './bot-group-transcript-rows'

const turn: Turn = {
  operationId: 'room-op',
  botId: 'bot-1',
  botName: 'Triage',
  avatar: null,
  agent: 'claude',
  sessionId: 'bot-group-member-1',
  frozenItems: []
}

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function renderTurn(shown: Turn) {
  return render(
    <TooltipProvider>
      <BotGroupTurn
        hostId="local"
        turn={shown}
        files={null}
        roomLinks={{ onLinkClick: undefined, request: () => {}, rootRef: createRef() }}
        roomRows={new BotGroupTranscriptRows()}
        tabId="room-tab"
        isVisible
        onStop={() => {}}
        onReply={() => {}}
        scrollMessageToTop={() => {}}
      />
    </TooltipProvider>
  )
}

it("draws the member's outfit as it was when the turn ran", async () => {
  // The outfit's art is a bundled file the page fetches; serve it from the checkout.
  vi.stubGlobal('fetch', async (url: string) => {
    const path = decodeURIComponent(new URL(url, 'http://test').pathname).replace(/^\/@fs/, '')
    const file = path.startsWith(process.cwd()) ? path : join(process.cwd(), path)
    return new Response(await readFile(file))
  })
  const view = renderTurn({ ...turn, avatar: 'mascot:A1', avatarOutfit: 'tie' })
  await vi.waitFor(() =>
    expect(view.container.querySelector('img[src^="data:image/webp"]')).not.toBeNull()
  )
})
