import { expect, it } from 'vitest'
import { connectorAskerPrompt, connectorMessageShown } from './connector-asker-prompt'

it('strips the generated prompt wrapper while preserving image-ref blocks on Slack image asks', () => {
  const prompt = connectorAskerPrompt('slack', {
    name: 'Alice',
    userId: 'U1',
    role: 'owner',
    place: { kind: 'public_channel', id: 'C1' },
    context: [],
    text: 'Look at this screenshot\n[image: shot.png, file F0123]'
  })

  const shown = connectorMessageShown({
    role: 'user',
    origin: 'connector',
    asker: { source: 'slack' },
    blocks: [
      { type: 'text', text: prompt },
      { type: 'image-ref', path: '/store/shot.png' }
    ]
  })

  expect(shown.blocks).toEqual([
    { type: 'text', text: 'Look at this screenshot\n[image: shot.png, file F0123]' },
    { type: 'image-ref', path: '/store/shot.png' }
  ])
})
