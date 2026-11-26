import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { NativeChatComposerNotices } from '../../composer/controls/NativeChatComposerNotices'
import { useNativeChatComposerNotice } from '../../composer/controls/use-native-chat-composer-notice'
import { setNativeChatAttachmentNotes } from '../../media/notes/native-chat-attachment-notes'
import { markNativeChatNotedImageEditing } from '../../media/notes/native-chat-chip-notes'
import { NativeChatImageAttachmentPreview } from './NativeChatImageAttachmentPreview'

const SCOPE = 'fixture:chip-refusal'

// A made-up marked screenshot, drawn here so the shot needs no files or network.
const PREVIEW = `data:image/svg+xml,${encodeURIComponent(
  [
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="76" viewBox="0 0 120 76">',
    '<rect width="120" height="76" fill="#f8fafc"/>',
    '<rect width="120" height="10" fill="#1e293b"/>',
    '<rect x="8" y="18" width="48" height="26" rx="3" fill="#e2e8f0"/>',
    '<rect x="64" y="18" width="48" height="26" rx="3" fill="#e2e8f0"/>',
    '<circle cx="30" cy="30" r="7" fill="#ef4444"/>',
    '</svg>'
  ].join('')
)}`

/** The message box's notice line above its chips, as the composer shows them. */
function ChipWithNotice(): React.JSX.Element {
  const { notices } = useNativeChatComposerNotice(undefined, null, SCOPE)
  return (
    <div className="native-chat-appearance flex flex-col gap-2 p-3">
      <NativeChatComposerNotices notices={notices} />
      <div className="flex gap-2">
        <NativeChatImageAttachmentPreview
          attachment={{
            id: 'marked',
            path: '/tmp/fixture/dashboard-notes.png',
            previewUrl: PREVIEW
          }}
          notesScopeKey={SCOPE}
          number={1}
          onRemove={() => {}}
        />
      </div>
    </div>
  )
}

/** Remove on a marked chip another viewer has open is refused, and the notice line says why. At
 *  the message box's narrowest width the line stays on one line. */
export const removeRefusedWhileEditing = defineFixture({
  width: 360,
  setup: () => {
    setNativeChatAttachmentNotes(SCOPE, 'marked', {
      mediaName: 'dashboard.png',
      source: { path: '/tmp/fixture/dashboard.png' },
      kind: 'image',
      notes: [
        { id: 'n1', number: 1, text: 'Align this card', mark: { kind: 'pin', x: 0.25, y: 0.4 } }
      ],
      offset: 0
    })
    // Another viewer of this chip, as its own chip would mark it.
    markNativeChatNotedImageEditing(SCOPE, 'marked')
  },
  render: () => <ChipWithNotice />,
  interact: (frame) => {
    frame.querySelector<HTMLButtonElement>('button[aria-label="Remove attachment"]')?.click()
  }
})
