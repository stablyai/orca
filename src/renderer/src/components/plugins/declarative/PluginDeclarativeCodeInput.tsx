import { useId, useLayoutEffect, useRef, useState } from 'react'
import { NativeChatHighlightedCode } from '@/components/native-chat/markdown/code/NativeChatHighlightedCode'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { cn } from '@/lib/class-names'
import { ImeTextarea } from '@/lib/text-input/ime/ime-text-field'
import type { PluginDeclarativeProps } from '../../../../../shared/plugins/declarative/plugin-declarative-catalog'
import { usePluginDeclarativeHostValue } from './plugin-declarative-host-value'
import { LabelledField, sendValue, type PluginDeclarativeEmit } from './PluginDeclarativeControls'
import {
  codeInputSegments,
  completionWordAt,
  insideString,
  isCompletionWordChar,
  matchCompletions,
  type PluginCodeInputCompletion
} from './plugin-declarative-code-input-text'

const IS_MAC = typeof navigator !== 'undefined' && navigator.userAgent.includes('Mac')
const LINE_PX = 20
const ZERO_WIDTH_SPACE = '\u200b'
const PADDING_PX = 16
// The three layers must break lines identically, or the caret drifts from the colored text.
const TEXT_LAYOUT =
  'm-0 block w-full border-0 px-3 py-2 font-mono text-xs leading-5 [overflow-wrap:anywhere] whitespace-pre-wrap [tab-size:2]'

/** Suggestions for the word `from`..`to`, offered while the caret stays at `to`. */
type Menu = { from: number; to: number; word: string }

export function PluginDeclarativeCodeInput({
  props,
  emit
}: {
  props: PluginDeclarativeProps<'CodeInput'>
  emit: PluginDeclarativeEmit
}): React.JSX.Element {
  const id = useId()
  const { value, change, readOnly, caughtUp } = usePluginDeclarativeHostValue({
    value: props.value,
    defaultValue: props.defaultValue,
    fallback: '',
    acked: props.$edit,
    actTarget: props,
    callback: props.onChange?.$callback,
    send: sendValue(emit)
  })
  const submit = props.onSubmit?.$callback
  const rows = props.rows ?? 1
  const maxRows = Math.max(rows, props.maxRows ?? rows)
  const textarea = useRef<HTMLTextAreaElement>(null)
  const scroller = useRef<HTMLDivElement>(null)
  const caretMark = useRef<HTMLSpanElement>(null)
  const accepting = useRef(false)
  const [caret, setCaret] = useState(0)
  const [menu, setMenu] = useState<Menu | null>(null)
  const [active, setActive] = useState(0)

  const editable = !readOnly && !props.disabled
  const items = menu && editable ? matchCompletions(props.completions ?? [], menu.word) : []
  const open = items.length > 0
  const shown = Math.min(active, Math.max(0, items.length - 1))
  // Ranges were computed for the text the guest last saw; while typing runs ahead of it (or with no
  // onChange, after any edit) they point elsewhere.
  const diagnostics =
    caughtUp && (props.value === undefined || props.value === value)
      ? (props.diagnostics ?? [])
      : []
  const segments = codeInputSegments(value, diagnostics, caret)

  useLayoutEffect(() => {
    const box = scroller.current
    const mark = caretMark.current
    if (!box || !mark || document.activeElement !== textarea.current) {
      return
    }
    const top = mark.offsetTop
    if (top < box.scrollTop) {
      box.scrollTop = top
    } else if (top + LINE_PX + PADDING_PX > box.scrollTop + box.clientHeight) {
      box.scrollTop = top + LINE_PX + PADDING_PX - box.clientHeight
    }
  }, [caret, value])

  const openAt = (text: string, cursor: number, explicit: boolean): void => {
    const word = completionWordAt(text, cursor)
    if (!explicit && (!word.word || insideString(text, cursor, props.quotes))) {
      setMenu(null)
      return
    }
    setMenu({ ...word, to: cursor })
    setActive(0)
  }

  /** Puts `text` over `from`..`to`, as typing would. */
  const replaceRange = (
    element: HTMLTextAreaElement,
    from: number,
    to: number,
    text: string
  ): void => {
    element.focus()
    element.setSelectionRange(from, to)
    accepting.current = true
    // execCommand keeps the edit on the textarea's undo stack; the input event reports it.
    const inserted = document.execCommand('insertText', false, text)
    accepting.current = false
    if (!inserted) {
      change(value.slice(0, from) + text + value.slice(to))
      const at = from + text.length
      requestAnimationFrame(() => element.setSelectionRange(at, at))
    }
  }

  const accept = (item: PluginCodeInputCompletion): void => {
    const element = textarea.current
    if (!element || !menu) {
      return
    }
    // The range belongs to where the menu opened; a caret that moved since would cut other text.
    if (element.selectionStart === menu.to && element.selectionEnd === menu.to) {
      replaceRange(element, menu.from, menu.to, item.insert ?? item.label)
    }
    setMenu(null)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) {
      return
    }
    if (open) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        const step = event.key === 'ArrowDown' ? 1 : -1
        setActive((shown + step + items.length) % items.length)
        return
      }
      const plainEnter =
        event.key === 'Enter' && !event.metaKey && !event.ctrlKey && !event.shiftKey
      if (plainEnter || event.key === 'Tab') {
        event.preventDefault()
        accept(items[shown]!)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        event.stopPropagation()
        setMenu(null)
        return
      }
    }
    if (event.key === ' ' && event.ctrlKey && editable) {
      event.preventDefault()
      const { selectionStart, selectionEnd } = event.currentTarget
      if (selectionStart === selectionEnd) {
        openAt(value, selectionStart, true)
      }
      return
    }
    if (event.key !== 'Enter') {
      return
    }
    const modifier = IS_MAC ? event.metaKey : event.ctrlKey
    if (modifier || (rows === 1 && !event.shiftKey)) {
      event.preventDefault()
      if (submit) {
        setMenu(null)
        // The host owns the text, so this submits exactly what is on screen.
        emit(submit, [value])
      }
      return
    }
    if (!editable) {
      return
    }
    // A line break keeps the current line's indent.
    event.preventDefault()
    setMenu(null)
    const element = event.currentTarget
    const { selectionStart, selectionEnd } = element
    const lineStart = value.lastIndexOf('\n', selectionStart - 1) + 1
    const indent = /^[ \t]*/.exec(value.slice(lineStart, selectionStart))?.[0] ?? ''
    replaceRange(element, selectionStart, selectionEnd, `\n${indent}`)
  }

  const onChange = (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const element = event.target
    change(element.value)
    setCaret(element.selectionStart)
    if (accepting.current) {
      return
    }
    const input = event.nativeEvent instanceof InputEvent ? event.nativeEvent : null
    const typed =
      input?.inputType === 'insertText' && [...(input.data ?? '')].every(isCompletionWordChar)
    if (typed || (menu && input?.inputType.startsWith('delete'))) {
      openAt(element.value, element.selectionStart, false)
    } else {
      setMenu(null)
    }
  }

  const listId = `${id}-completions`
  return (
    <LabelledField id={id} label={props.label} hidden={props.labelHidden}>
      <Popover open={open} onOpenChange={(next) => (next ? null : setMenu(null))}>
        <div
          ref={scroller}
          data-invalid={props.invalid === true}
          data-disabled={props.disabled === true}
          style={{
            minHeight: rows * LINE_PX + PADDING_PX + 2,
            maxHeight: maxRows * LINE_PX + PADDING_PX + 2
          }}
          className="scrollbar-sleek relative min-w-0 overflow-y-auto rounded-md border border-input bg-transparent shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50 data-[disabled=true]:cursor-not-allowed data-[disabled=true]:opacity-50 data-[invalid=true]:border-destructive data-[invalid=true]:ring-destructive/20 dark:bg-input/30 dark:data-[invalid=true]:ring-destructive/40"
        >
          <div className="relative">
            <pre
              aria-hidden
              style={{ minHeight: rows * LINE_PX + PADDING_PX }}
              className={cn(TEXT_LAYOUT, 'text-foreground')}
            >
              {props.language ? (
                <NativeChatHighlightedCode code={value} language={props.language} />
              ) : (
                value
              )}
              {/* A final line break starts a line the textarea shows; give the copy one too. */}
              {ZERO_WIDTH_SPACE}
            </pre>
            <pre
              aria-hidden
              className={cn(TEXT_LAYOUT, 'pointer-events-none absolute inset-0 text-transparent')}
            >
              {segments.map((segment, index) => (
                <span key={index}>
                  {segment.caret ? (
                    <PopoverAnchor asChild>
                      <span ref={caretMark} />
                    </PopoverAnchor>
                  ) : null}
                  {segment.tone ? (
                    <span
                      data-tone={segment.tone}
                      className="underline decoration-destructive decoration-wavy underline-offset-[3px] [text-decoration-skip-ink:none] data-[tone=warning]:decoration-status-warning-text"
                    >
                      {segment.text}
                    </span>
                  ) : (
                    segment.text
                  )}
                </span>
              ))}
            </pre>
            <ImeTextarea
              ref={textarea}
              id={id}
              value={value}
              readOnly={readOnly}
              disabled={props.disabled}
              placeholder={props.placeholder}
              maxLength={props.maxLength}
              spellCheck={false}
              autoCapitalize="off"
              autoComplete="off"
              autoCorrect="off"
              rows={rows}
              title={diagnostics.map((diagnostic) => diagnostic.message).join('\n') || undefined}
              role="combobox"
              aria-multiline={rows > 1}
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={open ? `${listId}-${shown}` : undefined}
              aria-invalid={props.invalid || undefined}
              aria-label={props.labelHidden ? props.label : undefined}
              className={cn(
                TEXT_LAYOUT,
                'absolute inset-0 h-full resize-none overflow-hidden bg-transparent text-transparent caret-foreground outline-none selection:bg-primary/30 placeholder:text-muted-foreground disabled:cursor-not-allowed'
              )}
              onChange={onChange}
              onKeyDown={onKeyDown}
              onSelect={(event) => {
                const { selectionStart, selectionEnd } = event.currentTarget
                setCaret(selectionStart)
                // Moving the caret off the word leaves its suggestions behind.
                setMenu((current) =>
                  current && selectionStart === current.to && selectionEnd === current.to
                    ? current
                    : null
                )
              }}
              onBlur={() => setMenu(null)}
            />
          </div>
        </div>
        <PopoverContent
          align="start"
          side="bottom"
          sideOffset={4}
          updatePositionStrategy="always"
          className="w-72 max-w-[calc(100vw-2rem)]"
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
        >
          <div
            id={listId}
            role="listbox"
            aria-label={props.label}
            className="scrollbar-sleek max-h-60 overflow-y-auto p-1"
          >
            {items.map((item, index) => (
              <div
                // oxlint-disable-next-line react-doctor/no-array-index-as-key -- labels may repeat across kinds.
                key={index}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={index === shown}
                data-active={index === shown}
                className="flex cursor-default items-baseline gap-2 rounded-sm px-2 py-1 font-mono text-xs data-[active=true]:bg-accent data-[active=true]:text-accent-foreground"
                ref={
                  index === shown ? (node) => node?.scrollIntoView({ block: 'nearest' }) : undefined
                }
                onPointerDown={(event) => event.preventDefault()}
                onPointerMove={() => (index === shown ? null : setActive(index))}
                onClick={() => accept(item)}
              >
                <span className="min-w-0 truncate text-foreground">{item.label}</span>
                {item.detail ? (
                  <span className="ml-auto min-w-0 truncate font-sans text-muted-foreground">
                    {item.detail}
                  </span>
                ) : null}
              </div>
            ))}
          </div>
        </PopoverContent>
      </Popover>
    </LabelledField>
  )
}
