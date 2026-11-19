import { defineFixture, type ComponentFixture } from '../../../component-fixtures/component-fixture'
import { fixtureCos } from '../../../component-fixtures/fixture-bot-panel'
import { makeFolderWorkspace } from '@/store/folder-workspaces/folder-workspace.test-fixture'
import { makeTestBotItem } from '../../../../../shared/bots/bot-item.test-fixture'
import type { BotItem } from '../../../../../shared/bots/bot-items'
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

function commentBox(
  target: BotItem,
  text: string
): Pick<ComponentFixture, 'store' | 'setup' | 'render'> {
  return {
    store: pastedImage.store,
    // Each theme's shot starts from the same draft.
    setup: () =>
      updateNativeChatComposerDraft(
        `bot-item-comment:${botRefKey(fixtureCos)}:${target.uid}`,
        { text, images: [] },
        'immediate'
      ),
    render: () => (
      <BotItemCommentBox
        bot={fixtureCos}
        item={target}
        attachTo={{
          worktreeId: folderWorkspaceKey(fixtureCos.folderWorkspaceId),
          runtimeEnvironmentId: null
        }}
        onSend={() => {}}
      />
    )
  }
}

/** Empty: four lines of room above the + / mic / send row. */
export const empty = defineFixture({ width: 380, ...commentBox(item, '') })

const LONG_ANSWER = [
  'Link expiry: 7 days by default, with a picker for 1 day, 30 days and never. Owners can change it after sharing.',
  'Resharing: only editors can reshare. Viewers see the link but the share button is disabled with a short reason.',
  'Guest history: guests see the current version only. Version history stays for signed-in members of the workspace.',
  'Rollout: ship behind the existing sharing flag, turn it on for our own workspace first, then everyone after a week if nothing breaks.',
  'Open question back to you: should expired links show a "request access" page or a plain 404?'
].join('\n\n')

/** A long multi-part answer: the box grows to its cap, then the text scrolls inside it. */
export const longText = defineFixture({
  width: 380,
  ...commentBox(item, LONG_ANSWER)
})

/** The narrowest right sidebar. */
export const narrow = defineFixture({
  width: 220,
  ...commentBox(item, '')
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
