import React from 'react'
import { LoaderCircle } from 'lucide-react'
import { ImeTextarea } from '@/lib/ime-text-field'
import { isScreenSubmitShortcut } from '@/lib/screen-submit-shortcut'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'

/** Inline-editable issue title: Enter or blur saves, the text wraps instead of scrolling. */
export function IssueTitleField({
  value,
  onChange,
  onSave,
  saving,
  className
}: {
  value: string
  onChange: (value: string) => void
  onSave: () => void
  saving: boolean
  className: string
}): React.JSX.Element {
  return (
    <div className="relative">
      <ImeTextarea
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onBlur={onSave}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || isScreenSubmitShortcut(event)) {
            event.preventDefault()
            event.currentTarget.blur()
          }
        }}
        disabled={saving}
        rows={1}
        aria-label={translate('auto.components.LinearIssueTextEditor.04d73b72dc', 'Issue title')}
        // CSS field sizing grows and rewraps titles without JS measurement.
        className={cn(
          'peer scrollbar-sleek block w-full resize-none overflow-hidden rounded-md border border-transparent bg-transparent px-1 py-0 text-foreground outline-none transition hover:border-border/50 hover:bg-accent/40 focus-visible:border-border focus-visible:bg-background focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-80',
          '[field-sizing:content]',
          className
        )}
      />
      <div className="pointer-events-none absolute bottom-1.5 right-2 z-10 flex items-center gap-1 text-[10px] text-muted-foreground/75 opacity-0 transition-opacity peer-focus:opacity-100">
        <kbd className="inline-flex h-4 min-w-4 select-none items-center justify-center rounded border border-border bg-muted/70 px-1 font-mono text-[9px] font-medium shadow-xs">
          ↵
        </kbd>
        <span>{translate('auto.components.LinearIssueTextEditor.947ba2d6f4', 'to save')}</span>
      </div>
      {saving ? (
        <LoaderCircle className="absolute right-2 top-2 size-4 animate-spin text-muted-foreground" />
      ) : null}
    </div>
  )
}
