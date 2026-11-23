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
        groupId="group"
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

// #46084: a long turn's rows fell off the member chat's loaded page, so the room read "Starting…".
it('draws an ended turn from its saved record when none of its rows are loaded', () => {
  const unloaded = { ...turn, frozenItems: undefined }
  const finished = renderTurn({
    ...unloaded,
    reply: 'Audit done.',
    end: 'finished',
    workedMs: 60_000
  })
  expect(finished.container.textContent).toContain('Audit done.')
  expect(finished.container.textContent).toContain('Worked for 1m')
  expect(finished.container.textContent).not.toContain('Starting')
  finished.unmount()
  const older = renderTurn({ ...unloaded, reply: null })
  expect(older.container.textContent).toContain('Ended')
  expect(older.container.textContent).toContain('Ended without a reply')
  expect(older.container.textContent).not.toContain('Starting')
  older.unmount()
  expect(renderTurn(unloaded).container.textContent).toContain('Starting')
})
