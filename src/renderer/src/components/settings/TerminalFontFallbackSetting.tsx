import { useState } from 'react'
import { ArrowDown, ArrowUp, Plus, Trash2 } from 'lucide-react'
import {
  MAX_TERMINAL_FONT_FALLBACKS,
  normalizeTerminalFontFallbacks
} from '../../../../shared/terminal-font-fallbacks'
import { Button } from '../ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip'
import { FontAutocomplete } from './FontAutocomplete'
import { translate } from '@/i18n/i18n'

type TerminalFontFallbackSettingProps = {
  value: string[]
  suggestions: string[]
  onChange: (value: string[]) => void
  onRequestSuggestions?: () => void
}

export function TerminalFontFallbackSetting({
  value,
  suggestions,
  onChange,
  onRequestSuggestions
}: TerminalFontFallbackSettingProps): React.JSX.Element {
  const [draft, setDraft] = useState('')
  const fallbacks = normalizeTerminalFontFallbacks(value)
  const draftIsDuplicate = fallbacks.some(
    (fallback) => fallback.toLowerCase() === draft.trim().toLowerCase()
  )

  const commitAt = (index: number, fontFamily: string): boolean => {
    const trimmed = fontFamily.trim()
    const duplicate = fallbacks.some(
      (fallback, candidate) =>
        candidate !== index && fallback.toLowerCase() === trimmed.toLowerCase()
    )
    if (!trimmed || duplicate) {
      return false
    }
    const next = [...fallbacks]
    next[index] = trimmed
    onChange(next)
    return true
  }

  const move = (index: number, offset: -1 | 1): void => {
    const destination = index + offset
    if (destination < 0 || destination >= fallbacks.length) {
      return
    }
    const next = [...fallbacks]
    ;[next[index], next[destination]] = [next[destination], next[index]]
    onChange(next)
  }

  const addDraft = (): void => {
    if (!draft.trim() || draftIsDuplicate || fallbacks.length >= MAX_TERMINAL_FONT_FALLBACKS) {
      return
    }
    onChange(normalizeTerminalFontFallbacks([...fallbacks, draft]))
    setDraft('')
  }

  return (
    <div className="w-80 max-w-full space-y-2">
      {fallbacks.length > 0 ? (
        <ol
          className="space-y-1"
          aria-label={translate(
            'auto.components.settings.TerminalFontFallbackSetting.212953bee6',
            'Terminal fallback fonts'
          )}
        >
          {fallbacks.map((fallback, index) => (
            <li key={index} className="flex items-center gap-1.5">
              <span className="w-4 shrink-0 text-right text-[11px] tabular-nums text-muted-foreground">
                {index + 1}
              </span>
              <FallbackFontInput
                value={fallback}
                index={index}
                suggestions={suggestions}
                onRequestSuggestions={onRequestSuggestions}
                onCommit={(fontFamily) => commitAt(index, fontFamily)}
              />
              <FallbackAction
                label={translate(
                  'auto.components.settings.TerminalFontFallbackSetting.36f45a7277',
                  'Move up'
                )}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp />
              </FallbackAction>
              <FallbackAction
                label={translate(
                  'auto.components.settings.TerminalFontFallbackSetting.5adea09881',
                  'Move down'
                )}
                disabled={index === fallbacks.length - 1}
                onClick={() => move(index, 1)}
              >
                <ArrowDown />
              </FallbackAction>
              <FallbackAction
                label={translate(
                  'auto.components.settings.TerminalFontFallbackSetting.7c2c7906a8',
                  'Remove fallback'
                )}
                onClick={() => onChange(fallbacks.filter((_, candidate) => candidate !== index))}
              >
                <Trash2 />
              </FallbackAction>
            </li>
          ))}
        </ol>
      ) : null}

      <div className="flex items-center gap-1.5 pl-5">
        <div className="min-w-0 flex-1">
          <FontAutocomplete
            value={draft}
            suggestions={suggestions}
            placeholder={translate(
              'auto.components.settings.TerminalFontFallbackSetting.a47b16e7af',
              'Add a font'
            )}
            ariaLabel={translate(
              'auto.components.settings.TerminalFontFallbackSetting.5674a5b618',
              'New fallback font'
            )}
            onRequestSuggestions={onRequestSuggestions}
            onChange={setDraft}
          />
        </div>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="shrink-0 gap-1.5"
          disabled={
            !draft.trim() || draftIsDuplicate || fallbacks.length >= MAX_TERMINAL_FONT_FALLBACKS
          }
          onClick={addDraft}
        >
          <Plus />
          {translate('auto.components.settings.TerminalFontFallbackSetting.14e6f886f2', 'Add')}
        </Button>
      </div>
      {fallbacks.length >= MAX_TERMINAL_FONT_FALLBACKS ? (
        <p className="text-[11px] text-muted-foreground">
          {translate(
            'auto.components.settings.TerminalFontFallbackSetting.f78f446a8d',
            'Maximum of 32 fallback fonts reached.'
          )}
        </p>
      ) : null}
    </div>
  )
}

type FallbackFontInputProps = {
  value: string
  index: number
  suggestions: string[]
  onRequestSuggestions?: () => void
  onCommit: (value: string) => boolean
}

function FallbackFontInput({
  value,
  index,
  suggestions,
  onRequestSuggestions,
  onCommit
}: FallbackFontInputProps): React.JSX.Element {
  const [draft, setDraft] = useState(value)
  const [previousValue, setPreviousValue] = useState(value)
  if (value !== previousValue) {
    setPreviousValue(value)
    setDraft(value)
  }

  const commit = (fontFamily: string): void => {
    if (!onCommit(fontFamily)) {
      setDraft(value)
    }
  }

  return (
    <div className="min-w-0 flex-1">
      <FontAutocomplete
        value={draft}
        suggestions={suggestions}
        ariaLabel={`${translate(
          'auto.components.settings.TerminalFontFallbackSetting.ff79a93a0d',
          'Fallback font'
        )} ${index + 1}`}
        onRequestSuggestions={onRequestSuggestions}
        onChange={setDraft}
        onCommit={commit}
      />
    </div>
  )
}

type FallbackActionProps = {
  label: string
  disabled?: boolean
  onClick: () => void
  children: React.ReactNode
}

function FallbackAction({
  label,
  disabled,
  onClick,
  children
}: FallbackActionProps): React.JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
        >
          {children}
        </Button>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={4}>
        {label}
      </TooltipContent>
    </Tooltip>
  )
}
