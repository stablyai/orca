import type { Dispatch, SetStateAction, RefObject } from 'react'
import { Trash2 } from 'lucide-react'
import { Textarea } from '@/components/ui/textarea'
import { translate } from '@/i18n/i18n'
import { ImageCommentTool } from './ImageCommentTool'
import type { ImageCommentPin } from './image-comment-pins'

export function ImageCommentSidebar({
  pins,
  selected,
  setPins,
  setSelected,
  saving,
  editorRef
}: {
  pins: ImageCommentPin[]
  selected: string | null
  setPins: Dispatch<SetStateAction<ImageCommentPin[]>>
  setSelected: Dispatch<SetStateAction<string | null>>
  saving: boolean
  editorRef: RefObject<HTMLTextAreaElement | null>
}): React.JSX.Element {
  const pin = pins.find((item) => item.id === selected)
  return (
    <aside className="flex max-h-[40dvh] w-full shrink-0 flex-col gap-3 overflow-hidden border-t border-border bg-background p-4 sm:max-h-none sm:w-80 sm:border-t-0 sm:border-l">
      <h3 className="text-sm font-medium">
        {translate('components.native-chat.imageComments.comments', 'Comments')}{' '}
        <span className="text-muted-foreground">{pins.length}</span>
      </h3>
      <p className="text-xs text-muted-foreground">
        {translate(
          'components.native-chat.imageComments.hint',
          'Click the image to add a numbered comment. Drag a pin to move it. Hold Alt to pan.'
        )}
      </p>
      <div className="scrollbar-sleek min-h-0 flex-1 overflow-auto">
        {pins.map((item, index) => (
          <div
            key={item.id}
            className="mb-1 flex items-center gap-1 rounded-md hover:bg-accent data-[current=true]:bg-accent"
            data-current={selected === item.id || undefined}
          >
            <button
              type="button"
              className="min-w-0 flex-1 rounded-md p-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              onClick={() => {
                setSelected(item.id)
                requestAnimationFrame(() => editorRef.current?.focus())
              }}
            >
              <span className="block truncate text-sm">
                {index + 1}.{' '}
                {item.comment ||
                  translate(
                    'components.native-chat.imageComments.emptyComment',
                    'Write a comment…'
                  )}
              </span>
              <span className="text-xs tabular-nums text-muted-foreground">
                x {item.x.toFixed(2)}% · y {item.y.toFixed(2)}%
              </span>
            </button>
            <ImageCommentTool
              label={translate(
                'components.native-chat.imageComments.delete',
                'Delete comment {{number}}',
                { number: index + 1 }
              )}
              disabled={saving}
              onClick={() => {
                setPins((items) => items.filter((candidate) => candidate.id !== item.id))
                if (selected === item.id) {
                  setSelected(null)
                }
              }}
            >
              <Trash2 />
            </ImageCommentTool>
          </div>
        ))}
      </div>
      {pin ? (
        <div className="space-y-2">
          <label className="text-xs font-medium" htmlFor={`image-comment-${pin.id}`}>
            {translate('components.native-chat.imageComments.pin', 'Comment {{number}}', {
              number: pins.indexOf(pin) + 1
            })}
          </label>
          <Textarea
            id={`image-comment-${pin.id}`}
            ref={editorRef}
            value={pin.comment}
            maxLength={4000}
            disabled={saving}
            rows={4}
            onChange={(event) =>
              setPins((items) =>
                items.map((item) =>
                  item.id === pin.id ? { ...item, comment: event.target.value } : item
                )
              )
            }
          />
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">
        {translate(
          'components.native-chat.imageComments.doneHint',
          'Done adds the marked image and comments to your draft. Nothing is sent automatically.'
        )}
      </p>
    </aside>
  )
}
