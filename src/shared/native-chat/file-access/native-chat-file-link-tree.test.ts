import { expect, it } from 'vitest'
import { linkNativeChatFilePaths } from './native-chat-file-link-tree'

it('links literal inline-code paths with an unmatched closing parenthesis when host-confirmed', () => {
  const tree = {
    type: 'paragraph',
    children: [
      { type: 'inlineCode', value: 'src/foo)bar.ts' },
      { type: 'inlineCode', value: 'src/missing)bar.ts' }
    ]
  }
  linkNativeChatFilePaths(tree, (link) => link.pathText === 'src/foo)bar.ts')
  expect(tree.children).toEqual([
    {
      type: 'link',
      url: '#orca-native-chat-file=src%2Ffoo)bar.ts',
      data: { nativeChatDetectedPath: true },
      children: [{ type: 'inlineCode', value: 'src/foo)bar.ts' }]
    },
    { type: 'inlineCode', value: 'src/missing)bar.ts' }
  ])
})
