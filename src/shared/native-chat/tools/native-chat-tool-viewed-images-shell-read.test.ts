import { expect, it } from 'vitest'

import { nativeChatToolRunViewedImages } from './native-chat-tool-viewed-images'

it('shows nothing for a shell read, which gave the agent bytes as text', () => {
  const codexCat = {
    type: 'tool-call',
    name: 'read',
    callId: 'c1',
    input: { command: 'cat /repo/images/shot.png', cwd: '/repo', path: '/repo/images/shot.png' }
  } as const
  expect(
    nativeChatToolRunViewedImages([codexCat, { type: 'tool-result', callId: 'c1', output: '' }])
  ).toEqual([])
})
