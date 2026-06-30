import { createPortal } from 'react-dom'
import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react'
import type { ArchitectureStatus } from '../architecture-diagram-types'
import { STATUS_COLORS } from './status-colors'

export type MentionItem = {
  name: string
  insertValue?: string
  kind: 'person' | 'system' | 'container' | 'component' | 'operation' | 'process' | 'model' | 'step'
  status?: ArchitectureStatus
  ref?: boolean
}

type MentionTextareaProps = {
  value: string
  onChange: (value: string) => void
  mentionNames: MentionItem[]
  placeholder?: string
  rows?: number
  autoSize?: boolean
  className?: string
  maxLength?: number
  autoFocus?: boolean
  testId?: string
  disabled?: boolean
  onBlur?: (value: string) => void
}

function getFilteredMentions(mentionNames: MentionItem[], query: string): MentionItem[] {
  const lowerQuery = query.toLowerCase()
  return [...mentionNames].sort((a, b) => {
    const aMatch = a.name.toLowerCase().includes(lowerQuery)
    const bMatch = b.name.toLowerCase().includes(lowerQuery)
    if (aMatch !== bMatch) {
      return aMatch ? -1 : 1
    }
    const aStarts = a.name.toLowerCase().startsWith(lowerQuery)
    const bStarts = b.name.toLowerCase().startsWith(lowerQuery)
    if (aStarts !== bStarts) {
      return aStarts ? -1 : 1
    }
    return a.name.localeCompare(b.name)
  })
}

export function MentionTextarea({
  value,
  onChange,
  mentionNames,
  placeholder,
  rows = 3,
  autoSize,
  className,
  maxLength,
  autoFocus,
  testId,
  disabled,
  onBlur
}: MentionTextareaProps): React.JSX.Element {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [localValue, setLocalValue] = useState(value)
  const [triggerPos, setTriggerPos] = useState<number | null>(null)
  const [query, setQuery] = useState('')
  const [dropdownPos, setDropdownPos] = useState<{
    top: number
    left: number
    width: number
  } | null>(null)
  const isEditingRef = useRef(false)

  useEffect(() => {
    if (!isEditingRef.current) {
      setLocalValue(value)
    }
  }, [value])

  const resizeTextarea = useCallback(() => {
    const ta = textareaRef.current
    if (!ta || !autoSize) {
      return
    }
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [autoSize])

  useEffect(() => {
    resizeTextarea()
  }, [localValue, resizeTextarea])

  useEffect(() => {
    if (!autoFocus) {
      return
    }
    const ta = textareaRef.current
    if (!ta) {
      return
    }
    ta.focus()
    ta.selectionStart = ta.selectionEnd = ta.value.length
  }, [autoFocus])

  const filtered = useMemo(
    () => (triggerPos !== null ? getFilteredMentions(mentionNames, query) : []),
    [mentionNames, query, triggerPos]
  )

  const updateDropdownPos = useCallback(() => {
    const ta = textareaRef.current
    if (!ta) {
      return
    }
    const rect = ta.getBoundingClientRect()
    setDropdownPos({ top: rect.bottom + 4, left: rect.left, width: rect.width })
  }, [])

  useEffect(() => {
    if (triggerPos !== null && filtered.length > 0) {
      updateDropdownPos()
    }
  }, [filtered.length, triggerPos, updateDropdownPos])

  const insertMention = useCallback(
    (item: MentionItem) => {
      if (triggerPos === null) {
        return
      }
      const ta = textareaRef.current
      const cursor = ta?.selectionStart ?? localValue.length
      const before = localValue.slice(0, triggerPos)
      const after = localValue.slice(cursor)
      const inserted = `@[${item.insertValue ?? item.name}]`
      const nextValue = `${before}${inserted}${after}`
      setLocalValue(nextValue)
      onChange(nextValue)
      setTriggerPos(null)
      setQuery('')
      requestAnimationFrame(() => {
        if (!ta) {
          return
        }
        ta.focus()
        const pos = before.length + inserted.length
        ta.setSelectionRange(pos, pos)
      })
    },
    [localValue, onChange, triggerPos]
  )

  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      const nextValue = event.currentTarget.value
      isEditingRef.current = true
      setLocalValue(nextValue)
      onChange(nextValue)
      requestAnimationFrame(() => {
        isEditingRef.current = false
      })

      const cursor = event.currentTarget.selectionStart ?? nextValue.length
      const before = nextValue.slice(0, cursor)
      const atIdx = before.lastIndexOf('@')
      if (atIdx === -1) {
        setTriggerPos(null)
        setQuery('')
        return
      }
      const afterAt = before.slice(atIdx)
      if (afterAt.includes(']')) {
        setTriggerPos(null)
        setQuery('')
        return
      }
      setTriggerPos(atIdx)
      const raw = before.slice(atIdx + 1)
      setQuery(raw.startsWith('[') ? raw.slice(1) : raw)
    },
    [onChange]
  )

  return (
    <div>
      <textarea
        ref={textareaRef}
        className={className}
        value={localValue}
        placeholder={placeholder}
        rows={rows}
        maxLength={maxLength}
        data-testid={testId}
        disabled={disabled}
        onChange={handleChange}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && triggerPos !== null) {
            setTriggerPos(null)
            setQuery('')
          }
          if (
            event.key === 'Enter' &&
            triggerPos !== null &&
            filtered.length > 0 &&
            !event.shiftKey
          ) {
            event.preventDefault()
            insertMention(filtered[0])
          }
        }}
        onBlur={() => {
          onBlur?.(localValue)
          setTimeout(() => {
            setTriggerPos(null)
            setQuery('')
          }, 150)
        }}
      />
      {triggerPos !== null && filtered.length > 0 && dropdownPos
        ? createPortal(
            <div
              className="scrollbar-sleek fixed z-[9999] max-h-32 overflow-y-auto overflow-x-hidden rounded-md border border-[var(--border)] bg-[var(--surface-raised)] shadow-lg"
              style={{
                top: dropdownPos.top,
                left: dropdownPos.left,
                width: dropdownPos.width
              }}
              data-testid="architecture-mention-dropdown"
            >
              {filtered.map((item) => {
                const statusStyle = item.status ? STATUS_COLORS[item.status] : null
                return (
                  <button
                    key={`${item.kind}:${item.name}:${item.insertValue ?? ''}`}
                    type="button"
                    className={`flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left text-xs hover:bg-[var(--surface-tint)] ${
                      statusStyle?.text ?? 'text-[var(--text-secondary)]'
                    } ${item.ref ? 'italic' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => insertMention(item)}
                    data-testid="architecture-mention-option"
                  >
                    {item.ref ? (
                      <span className="text-[10px] text-[var(--text-muted)]">-&gt;</span>
                    ) : null}
                    <span className={item.kind === 'operation' ? 'font-mono' : ''}>
                      {item.name}
                    </span>
                    <span className="ml-auto text-[10px] text-[var(--text-muted)]">
                      {item.kind}
                    </span>
                  </button>
                )
              })}
            </div>,
            document.body
          )
        : null}
    </div>
  )
}
