import { useId, type RefObject } from 'react'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { WorkspaceEmojiSuggestionPopover } from '@/components/workspace-emoji/WorkspaceEmojiSuggestionPopover'
import { useWorkspaceEmojiShortcodeInput } from '@/components/workspace-emoji/useWorkspaceEmojiShortcodeInput'
import { translate } from '@/i18n/i18n'

type WorktreeDisplayNameFieldProps = {
  disabled: boolean
  inputRef: RefObject<HTMLInputElement | null>
  onEnter: () => void | Promise<void>
  onValueChange: (value: string) => void
  portalContainer: HTMLElement | null
  value: string
}

export function WorktreeDisplayNameField({
  disabled,
  inputRef,
  onEnter,
  onValueChange,
  portalContainer,
  value
}: WorktreeDisplayNameFieldProps): React.JSX.Element {
  const inputId = useId()
  const emojiInput = useWorkspaceEmojiShortcodeInput({
    disabled,
    inputRef,
    onValueChange,
    value
  })

  return (
    <div className="space-y-1">
      <Label htmlFor={inputId} className="text-[11px] font-medium text-muted-foreground">
        {translate('auto.components.sidebar.WorktreeMetaDialog.ad5e4e514f', 'Display Name')}
      </Label>
      <Input
        id={inputId}
        ref={inputRef}
        value={value}
        onChange={(event) =>
          emojiInput.handleValueChange(event.target.value, event.target.selectionStart)
        }
        onSelect={(event) => emojiInput.syncCursor(event.currentTarget)}
        onKeyDown={(event) => {
          if (emojiInput.handleKeyDown(event) || event.key !== 'Enter') {
            return
          }
          event.preventDefault()
          void onEnter()
        }}
        placeholder={translate(
          'auto.components.sidebar.WorktreeMetaDialog.7f21e0464f',
          'Custom display name...'
        )}
        className="h-8 text-xs"
      />
      <WorkspaceEmojiSuggestionPopover
        anchorRef={inputRef}
        open={emojiInput.open}
        commandValue={emojiInput.commandValue}
        heading={translate('auto.components.new.workspace.SmartWorkspaceNameField.emoji', 'Emoji')}
        suggestions={emojiInput.suggestions}
        onCommandValueChange={emojiInput.onCommandValueChange}
        onSelect={emojiInput.selectSuggestion}
        onOpenChange={(open) => !open && emojiInput.close()}
        portalContainer={portalContainer}
        side="bottom"
      />
      <p className="text-[10px] text-muted-foreground">
        {translate(
          'auto.components.sidebar.WorktreeMetaDialog.459ad7f650',
          'Only changes the name shown in the sidebar — the folder on disk stays the same. Leave blank to use the branch or folder name.'
        )}
      </p>
    </div>
  )
}
