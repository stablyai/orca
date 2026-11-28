import { useLayoutEffect } from 'react'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { translate } from '@/i18n/i18n'
import { Button } from '@/components/ui/button'
import { NativeChatMediaNotesPanel } from './NativeChatMediaNotesPanel'
import { useNativeChatNotesEditor } from './use-native-chat-notes-editor'
import type { NativeChatMediaNote } from './native-chat-media-notes'

const NOTES: NativeChatMediaNote[] = [
  {
    id: 'n1',
    number: 1,
    text: 'Align this card with the other two',
    mark: { kind: 'pin', x: 0.4, y: 0.2 }
  },
  { id: 'n2', number: 2, text: 'Use the product name here', mark: { kind: 'pin', x: 0.1, y: 0.1 } }
]
const noop = (): void => {}

/** The notes sheet of a narrow window after Close found the message box can't take the notes: the
 *  reason, with Discard beside it. Made-up notes only. */
function ClosedWithReason({ reason }: { reason: string }): React.JSX.Element {
  const editor = useNativeChatNotesEditor({ notes: NOTES })
  const { setStatus } = editor
  useLayoutEffect(
    () => setStatus({ kind: 'error', message: reason, discard: noop }),
    [reason, setStatus]
  )
  return (
    <div className="bg-media-canvas p-0 pt-24">
      <NativeChatMediaNotesPanel
        editor={editor}
        preciseTimes={false}
        narrow
        onHide={noop}
        onConfirmed={noop}
        onEditorClosed={noop}
        sendSlot={
          <Button type="button" variant="media-note" size="sm" aria-disabled>
            {translate('components.native-chat.notes.send', 'Send')}
          </Button>
        }
      />
    </div>
  )
}

const closed = (width: number, key: string, fallback: string) =>
  defineFixture({
    width,
    render: () => (
      <ClosedWithReason reason={translate(`components.native-chat.notes.${key}`, fallback)} />
    )
  })

export const commandHeld320 = closed(320, 'closeCommand', 'The box holds a command.')
export const commandHeld360 = closed(360, 'closeCommand', 'The box holds a command.')
export const noMessageBox320 = closed(320, 'closeNoMessageBox', 'No message box to add notes to.')
export const goalHeld320 = closed(320, 'closeGoal', 'Setting a goal takes no images.')
export const queuedEdit320 = closed(320, 'closeEditingQueued', 'Finish the queued edit first.')
export const failed320 = closed(320, 'closeFailed', 'Couldn’t add the marked image.')
export const notReady320 = closed(320, 'imageNotReady', 'The image isn’t ready yet.')
