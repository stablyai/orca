import { defineFixture } from '../../../component-fixtures/component-fixture'
import iconUrl from '../../../../../../resources/icon.png?url'
import { NativeChatMarkdownImageOwnerContext } from '../media/images/native-chat-markdown-image-owner'
import { NativeChatMarkdown } from './NativeChatMarkdown'

const owner = {
  fileLinkContext: {
    worktreeId: 'fixture-workspace',
    worktreePath: '/fixture',
    runtimeEnvironmentId: null
  },
  runtimeContext: {
    target: { kind: 'local' as const },
    worktreeId: 'fixture-workspace',
    worktreePath: '/fixture',
    expectedExecutionHostId: 'local' as const
  },
  isVisible: true
}

export const imageLinks = defineFixture({
  width: 640,
  setup: async () => {
    const response = await fetch(iconUrl)
    const bytes = new Uint8Array(await response.arrayBuffer())
    const content = btoa(Array.from(bytes, (byte) => String.fromCharCode(byte)).join(''))
    window.api.fs.readFile = async () => ({ content, isBinary: true, mimeType: 'image/png' })
  },
  render: () => (
    <NativeChatMarkdownImageOwnerContext.Provider value={owner}>
      <div className="native-chat-appearance p-6 text-sm text-chat-foreground">
        <NativeChatMarkdown
          variant="document"
          content={
            'Here is the exported icon:\n\n[Orca icon](resources/icon.png)\n\nThe same image, linked by reference:\n\n[Referenced icon][icon]\n\n[icon]: resources/icon.png "Orca"\n\nSee [the icon](resources/icon.png) for details.'
          }
        />
      </div>
    </NativeChatMarkdownImageOwnerContext.Provider>
  ),
  interact: async (frame) => {
    await Promise.all(
      Array.from(frame.querySelectorAll('img'), (image) => image.decode().catch(() => {}))
    )
  }
})
