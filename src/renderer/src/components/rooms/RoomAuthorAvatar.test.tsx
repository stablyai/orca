import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { RoomParticipant } from '../../../../shared/rooms'
import { RoomAuthorAvatar } from './RoomAuthorAvatar'

describe('RoomAuthorAvatar', () => {
  it('uses the participant harness icon for agents', () => {
    const markup = renderToStaticMarkup(
      <RoomAuthorAvatar actorKind="agent" participant={{ agent: 'codex' } as RoomParticipant} />
    )

    expect(markup).toContain('data-room-author-avatar="agent"')
    expect(markup).toContain('<svg')
  })
})
