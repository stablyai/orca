import { defineFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import { folderWorkspaceKey } from '../../../../../shared/workspace/identity/workspace-scope'
import { botRefKey } from '@/lib/bot-hosts'
import { updateNativeChatComposerDraft } from '../../native-chat/drafts/native-chat-composer-draft-store'
import { BotItemCommentBox } from './BotItemCommentBox'
import { BotItemCommentCard } from './BotItemCommentCard'

const item = makeTestBotItem(7, { title: 'Fix the share dialog' })

// A 1x1 dark pixel, as a pasted screenshot's bytes.
const PIXEL = Uint8Array.from(
  atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
  ),
  (char) => char.charCodeAt(0)
)

async function pasteImage(frame: HTMLElement): Promise<void> {
  const editor = frame.querySelector<HTMLElement>('[contenteditable="true"]')
  if (!editor) {
    throw new Error('no editor')
  }
  editor.focus()
  document.execCommand('insertText', false, 'The dialog clips here ')
  await new Promise((resolve) => setTimeout(resolve, 50))
  const data = new DataTransfer()
  data.items.add(new File([PIXEL], 'image.png', { type: 'image/png' }))
  editor.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }))
  await new Promise((resolve) => setTimeout(resolve, 300))
  document.execCommand('insertText', false, 'on narrow windows.')
  await new Promise((resolve) => setTimeout(resolve, 100))
}

/** Text, then an image pasted at the caret, then more text, as in chat's composer. */
export const pastedImage = defineFixture({
  width: 380,
  store: {
    folderWorkspaces: [
      makeFolderWorkspace({
        id: fixtureCos.folderWorkspaceId,
        folderPath: '/home/me/.orca/bots/cos'
      })
    ]
  },
  setup: () => {
    // Each theme's shot starts from an empty box.
    updateNativeChatComposerDraft(
      `bot-item-comment:${botRefKey(fixtureCos)}:${item.uid}`,
      { text: '', images: [] },
      'immediate'
    )
    window.api.ui.saveClipboardImageAsTempFile = async () => '/home/me/.orca/attachments/image.png'
  },
  interact: pasteImage,
  render: () => (
    <BotItemCommentBox
      bot={fixtureCos}
      item={item}
      attachTo={{
        worktreeId: folderWorkspaceKey(fixtureCos.folderWorkspaceId),
        runtimeEnvironmentId: null
      }}
      onSend={() => {}}
    />
  )
})

/** One line typed: the compact send sits level with the + and the text. */
export const oneLine = defineFixture({
  width: 380,
  store: pastedImage.store,
  setup: () => {
    updateNativeChatComposerDraft(
      `bot-item-comment:${botRefKey(fixtureCos)}:${item.uid}`,
      { text: 'Looks good, ship it.', images: [] },
      'immediate'
    )
  },
  render: pastedImage.render
})

/** That comment posted: its image above the words, without the [Image #1] its send wrote, as chat shows a sent message. */
export const posted = defineFixture({
  width: 380,
  render: () => (
    <BotItemCommentCard
      bot={fixtureCos}
      item={item}
      entry={{
        event: {
          id: 'e1',
          kind: 'commented',
          actor: { kind: 'owner' },
          at: 1_700_000_000_000,
          data: {
            text: 'The dialog clips here [Image #1] on narrow windows.',
            images: [{ path: '/home/me/.orca/attachments/image.png', name: 'image.png', bytes: 70 }]
          }
        }
      }}
    />
  )
})
