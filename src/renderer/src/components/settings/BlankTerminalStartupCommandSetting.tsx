import { useId, useState } from 'react'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Label } from '../ui/label'
import { translate } from '@/i18n/i18n'
import {
  getBlankTerminalStartupCommandDescription,
  getBlankTerminalStartupCommandTitle
} from './blank-terminal-startup-command-copy'

type BlankTerminalStartupCommandSettingProps = {
  value: string
  onSave: (value: string) => void
}

export function BlankTerminalStartupCommandSetting({
  value,
  onSave
}: BlankTerminalStartupCommandSettingProps): React.JSX.Element {
  const inputId = useId()
  const [draft, setDraft] = useState(value)

  const commit = (): void => {
    const trimmed = draft.trim()
    setDraft(trimmed)
    if (trimmed !== value) {
      onSave(trimmed)
    }
  }

  const reset = (): void => {
    setDraft('')
    if (value) {
      onSave('')
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={inputId} className="select-text">
        {getBlankTerminalStartupCommandTitle()}
      </Label>
      <p className="select-text text-xs text-muted-foreground">
        {getBlankTerminalStartupCommandDescription()}
      </p>
      <div className="flex items-center gap-2">
        <Input
          id={inputId}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              commit()
              e.currentTarget.blur()
            }
            if (e.key === 'Escape') {
              setDraft(value)
              e.currentTarget.blur()
            }
          }}
          placeholder={translate(
            'auto.components.settings.BlankTerminalStartupCommandSetting.46cd88e30c',
            'e.g. tc'
          )}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          className="h-7 max-w-md flex-1 font-mono text-xs"
        />
        {value && (
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={reset}
            className="h-7 shrink-0 text-xs text-muted-foreground hover:text-foreground"
          >
            {translate(
              'auto.components.settings.BlankTerminalStartupCommandSetting.15ee1eaa3e',
              'Reset'
            )}
          </Button>
        )}
      </div>
    </div>
  )
}
