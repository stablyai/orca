import { roomParticipantFixture } from '../../../../shared/rooms.test-fixture'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'

import { RoomAuthorAvatar } from './RoomAuthorAvatar'

describe('RoomAuthorAvatar', () => {
  it('uses the participant harness icon for agents', () => {
    const markup = renderToStaticMarkup(
      <RoomAuthorAvatar
        actorKind="agent"
        participant={roomParticipantFixture({ agent: 'codex' })}
      />
    )

    expect(markup).toContain('data-room-author-avatar="agent"')
    expect(markup).toContain('<svg')
  })
})
