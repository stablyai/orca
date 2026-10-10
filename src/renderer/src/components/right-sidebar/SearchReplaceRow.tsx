import React from 'react'
import { CaseUpper, Loader2, Replace, ReplaceAll } from 'lucide-react'
import { ImeInput } from '@/lib/ime-text-field'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { ShortcutKeyCombo } from '@/components/ShortcutKeyCombo'
import { translate } from '@/i18n/i18n'
import { ToggleButton } from './SearchResultItems'

export type SearchReplaceRowProps = {
  inputRef: React.Ref<HTMLInputElement>
  replaceText: string
  preserveCase: boolean
  canReplaceAll: boolean
  replacing: boolean
  /** Why replace is unavailable for the current search, if it is. */
  error: string | null
  onReplaceTextChange: (value: string) => void
  onTogglePreserveCase: () => void
  onReplaceAll: () => void
}

function isReplaceAllShortcut(event: React.KeyboardEvent, isMac: boolean): boolean {
  return (
    event.key === 'Enter' &&
    event.altKey &&
    !event.shiftKey &&
    (isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  )
}

export function SearchReplaceRow({
  inputRef,
  replaceText,
  preserveCase,
  canReplaceAll,
  replacing,
  error,
  onReplaceTextChange,
  onTogglePreserveCase,
  onReplaceAll
}: SearchReplaceRowProps): React.JSX.Element {
  const isMac = navigator.userAgent.includes('Mac')
  const replaceAllLabel = translate(
    'auto.components.right.sidebar.SearchReplace.replaceAll',
    'Replace All'
  )

  return (
    <div className="flex flex-col gap-1" data-ignore-file-explorer-keys="true">
      <div className="flex items-center gap-1">
        <div className="flex h-7 min-w-0 flex-1 items-center gap-1 rounded-sm border border-border bg-input/50 px-1.5 focus-within:border-ring">
          <Replace className="size-3.5 shrink-0 text-muted-foreground" />
          <ImeInput
            ref={inputRef}
            type="text"
            data-file-search-input="true"
            className="min-w-0 flex-1 bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
            aria-label={translate(
              'auto.components.right.sidebar.SearchReplace.inputLabel',
              'Replace'
            )}
            aria-invalid={error ? true : undefined}
            placeholder={translate(
              'auto.components.right.sidebar.SearchReplace.inputLabel',
              'Replace'
            )}
            value={replaceText}
            onChange={(event) => onReplaceTextChange(event.target.value)}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing) {
                return
              }
              if (isReplaceAllShortcut(event, isMac)) {
                event.preventDefault()
                if (canReplaceAll) {
                  onReplaceAll()
                }
              } else if (event.key === 'Escape') {
                event.preventDefault()
                event.stopPropagation()
                event.currentTarget.blur()
              }
            }}
            spellCheck={false}
          />
          {replacing ? (
            <Loader2 className="size-3 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          <ToggleButton
            active={preserveCase}
            onClick={onTogglePreserveCase}
            title={translate(
              'auto.components.right.sidebar.SearchReplace.preserveCase',
              'Preserve Case'
            )}
          >
            <CaseUpper className="size-3.5" />
          </ToggleButton>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label={replaceAllLabel}
              disabled={!canReplaceAll || replacing}
              onClick={onReplaceAll}
            >
              <ReplaceAll className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top" sideOffset={4}>
            <span className="flex items-center gap-2">
              {replaceAllLabel}
              <ShortcutKeyCombo keys={isMac ? ['⌘', '⌥', '↵'] : ['Ctrl', 'Alt', 'Enter']} />
            </span>
          </TooltipContent>
        </Tooltip>
      </div>
      {error ? <p className="px-1 text-[11px] text-destructive">{error}</p> : null}
    </div>
  )
}
