import { describe, expect, it } from 'vitest'
import { AGENT_TUI_CLEAR_INPUT_MAX } from '../../../../shared/agent-tui-input-clear'
import { literalRoomTransportText } from './native-chat-room-transport'

describe('literalRoomTransportText', () => {
  it('recognizes Rooms deliveries and exact silent acknowledgements', () => {
    expect(literalRoomTransportText('<orca-room-delivery id="delivery-1">\nhello')).toBe(
      '<orca-room-delivery id="delivery-1">\nhello'
    )
    expect(literalRoomTransportText('<orca-room-silent />')).toBe('<orca-room-silent />')
    expect(literalRoomTransportText('Done.\n<orca-room-silent />')).toBeNull()
  })

  it('removes leading terminal controls', () => {
    expect(
      literalRoomTransportText(
        `${AGENT_TUI_CLEAR_INPUT_MAX}<orca-room-delivery id="delivery-1">\nhello`
      )
    ).toBe('<orca-room-delivery id="delivery-1">\nhello')
  })

  it('keeps recipient transport out of Markdown', () => {
    const reply = 'Done.\n<orca-room-recipients>["claude2"]</orca-room-recipients>'
    expect(literalRoomTransportText(reply)).toBe(reply)
    expect(literalRoomTransportText('Ordinary **Markdown**')).toBeNull()
  })
})
