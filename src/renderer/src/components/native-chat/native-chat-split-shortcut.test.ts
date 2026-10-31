import { expect, it } from 'vitest'
import {
  matchNativeChatSplitShortcut,
  nativeChatSplitShortcutLabels
} from './native-chat-split-shortcut'

const modD = { key: 'd', code: 'KeyD', control: false, meta: true, alt: false, shift: false }

it('a terminal split bound to the default split chord wins inside chats', () => {
  expect(matchNativeChatSplitShortcut(modD, 'darwin', {})).toEqual({
    direction: 'right',
    opensTerminal: false
  })
  expect(
    matchNativeChatSplitShortcut(modD, 'darwin', { 'chat.splitTerminalRight': ['Mod+D'] })
  ).toEqual({ direction: 'right', opensTerminal: true })
})

it('the chat split menu hides a chord a terminal split claims', () => {
  expect(nativeChatSplitShortcutLabels('darwin', {})).toEqual({ right: '⌘D', down: '⌘⇧D' })
  expect(nativeChatSplitShortcutLabels('darwin', { 'chat.splitTerminalDown': ['Mod+D'] })).toEqual({
    right: '',
    down: '⌘⇧D'
  })
})
