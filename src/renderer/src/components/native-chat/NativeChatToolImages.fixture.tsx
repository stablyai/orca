import { defineFixture } from '../../component-fixtures/component-fixture'
import type { NativeChatMessage } from '../../../../shared/native-chat/native-chat-types'
import { MessageRow } from './NativeChatMessageRow'
import { NativeChatMarkdownImageOwnerContext } from './native-chat-markdown-image-owner'

const READ_PATH = '/tmp/read-shot.png'
const PURPOSE_PATH = '/tmp/on-purpose.png'

const runtimeContext = {
  target: { kind: 'local' as const },
  worktreeId: 'wt-images',
  worktreePath: '/tmp',
  expectedExecutionHostId: 'local' as const
}

const imageOwner = {
  fileLinkContext: {
    worktreeId: 'wt-images',
    worktreePath: '/tmp',
    runtimeEnvironmentId: null
  },
  runtimeContext,
  isVisible: true,
  sessionId: 'session-images'
}

let remoteSrc = ''
let readBytes = ''
let purposeBytes = ''

function paint(
  draw: (context: CanvasRenderingContext2D, width: number, height: number) => void
): string {
  const canvas = document.createElement('canvas')
  canvas.width = 200
  canvas.height = 200
  const context = canvas.getContext('2d')
  if (!context) {
    return ''
  }
  draw(context, canvas.width, canvas.height)
  const url = canvas.toDataURL('image/png')
  return url.slice(url.indexOf(',') + 1)
}

function message(id: string, blocks: NativeChatMessage['blocks']): NativeChatMessage {
  return { id, role: 'assistant', source: 'transcript', timestamp: 1_800_000_000_000, blocks }
}

function chat(): React.JSX.Element {
  const read = message('read', [
    { type: 'text', text: 'Screenshot from the Read tool.' },
    {
      type: 'tool-call',
      name: 'Read',
      input: { file_path: READ_PATH },
      callId: 'toolu_read',
      state: 'completed'
    },
    { type: 'tool-result', output: '', callId: 'toolu_read' },
    { type: 'image-ref', path: READ_PATH, alt: 'read-shot.png' }
  ])
  const purpose = message('purpose', [
    {
      type: 'text',
      text: `On purpose:\n\n![Purpose](${PURPOSE_PATH})\n\n![Remote](${remoteSrc})`
    }
  ])
  const row = (item: NativeChatMessage): React.JSX.Element => (
    <MessageRow
      message={item}
      expandSignal={false}
      onScrollMessageToTop={() => {}}
      runtimeContext={runtimeContext}
    />
  )
  return (
    <NativeChatMarkdownImageOwnerContext.Provider value={imageOwner}>
      <div className="space-y-6 bg-chat-canvas p-4 text-chat-foreground">
        {row(read)}
        {row(purpose)}
      </div>
    </NativeChatMarkdownImageOwnerContext.Provider>
  )
}

export const dark = defineFixture({
  width: 720,
  setup() {
    readBytes = paint((context, width, height) => {
      context.fillStyle = '#1e293b'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#2563eb'
      context.fillRect(0, 0, width, 36)
      context.fillStyle = '#f8fafc'
      context.font = '16px sans-serif'
      context.fillText('Session screenshot', 16, 24)
      context.fillStyle = '#cbd5e1'
      context.font = '14px sans-serif'
      for (let line = 0; line < 5; line += 1) {
        context.fillRect(16, 56 + line * 26, 150 - line * 16, 10)
      }
    })
    purposeBytes = paint((context, width, height) => {
      context.fillStyle = '#f8fafc'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#16a34a'
      ;[48, 72, 110, 84, 140].forEach((bar, index) => {
        context.fillRect(16 + index * 36, height - 16 - bar, 24, bar)
      })
    })
    const remote = paint((context, width, height) => {
      context.fillStyle = '#7c3aed'
      context.fillRect(0, 0, width, height)
      context.fillStyle = '#fde68a'
      context.beginPath()
      context.arc(width / 2, height / 2, 60, 0, Math.PI * 2)
      context.fill()
    })
    remoteSrc = `data:image/png;base64,${remote}`
    const readFile = window.api.fs.readFile.bind(window.api.fs)
    window.api.fs.readFile = (args) => {
      const content = args.filePath.includes('read-shot.png')
        ? readBytes
        : args.filePath.includes('on-purpose.png')
          ? purposeBytes
          : null
      return content
        ? Promise.resolve({ content, isBinary: true, mimeType: 'image/png' })
        : readFile(args)
    }
  },
  async interact(frame) {
    const started = Date.now()
    while (Date.now() - started < 8000) {
      const images = [...frame.querySelectorAll('img')]
      if (images.length >= 3 && images.every((image) => image.complete && image.naturalWidth > 0)) {
        return
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    const images = [...frame.querySelectorAll('img')]
    throw new Error(`chat images not ready (${images.length})`)
  },
  render: chat
})
