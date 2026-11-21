import React, { useCallback, useRef, useState } from 'react'
import { File } from 'lucide-react'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useTranslate } from '@/i18n/use-translate'
import { pasteTextIntoTextControl } from '@/lib/text-input/paste/text-control-paste'
import { FileExplorerPasteMenuItem } from '../panel/file-explorer-paste-menu-item'
import { FolderIcon } from '@/components/icons/FileTypeIcon'
import {
  isImeCompositionKeyDown,
  useImeEnterGestureOwnership
} from '@/lib/text-input/ime/ime-composition-keyboard-event'
import type { TreeNode } from '../tree/file-explorer-types'

export type InlineInput = {
  parentPath: string
  type: 'file' | 'folder' | 'rename'
  depth: number
  existingName?: string
  existingPath?: string
  operationOwner?: TreeNode['operationOwner']
}

type InputSelection = {
  start: number
  end: number
  direction: NonNullable<HTMLInputElement['selectionDirection']>
}

export function InlineInputRow({
  depth,
  inlineInput,
  onSubmit,
  onCancel
}: {
  depth: number
  inlineInput: InlineInput
  onSubmit: (value: string) => void
  onCancel: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [clipboardText, setClipboardText] = useState('')
  const menuTarget = useRef<HTMLInputElement | null>(null)
  const menuSelection = useRef<InputSelection | null>(null)
  const menuRequest = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimeout = useRef<ReturnType<typeof setTimeout> | null>(null)
  const submitted = useRef(false)
  const imeEnter = useImeEnterGestureOwnership()
  // Refocus during menu-close grace so temporary focus restoration cannot dismiss the empty input.
  const focusSettled = useRef(false)
  const focusFrame = useRef<number | null>(null)
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const refocusFrame = useRef<number | null>(null)
  const inlineInputKey = [
    inlineInput.type,
    inlineInput.parentPath,
    inlineInput.depth,
    inlineInput.existingPath ?? '',
    inlineInput.existingName ?? ''
  ].join('\0')

  const cancelRefocusFrame = useCallback((): void => {
    if (refocusFrame.current !== null) {
      cancelAnimationFrame(refocusFrame.current)
      refocusFrame.current = null
    }
  }, [])

  const scheduleInputRefocus = useCallback((): void => {
    cancelRefocusFrame()
    refocusFrame.current = requestAnimationFrame(() => {
      refocusFrame.current = null
      inputRef.current?.focus()
    })
  }, [cancelRefocusFrame])

  const captureInputSelection = useCallback((input: HTMLInputElement): void => {
    const start = input.selectionStart ?? input.value.length
    menuSelection.current = {
      start,
      end: input.selectionEnd ?? start,
      direction: input.selectionDirection ?? 'none'
    }
  }, [])

  const restoreInputSelection = useCallback((): void => {
    const input = inputRef.current
    const selection = menuSelection.current
    menuSelection.current = null
    if (!input) {
      return
    }
    input.focus()
    if (selection) {
      input.setSelectionRange(selection.start, selection.end, selection.direction)
    }
  }, [])

  const clearInlineInputTimers = useCallback(() => {
    if (focusFrame.current !== null) {
      cancelAnimationFrame(focusFrame.current)
      focusFrame.current = null
    }
    cancelRefocusFrame()
    if (blurTimeout.current) {
      clearTimeout(blurTimeout.current)
      blurTimeout.current = null
    }
    if (settleTimer.current) {
      clearTimeout(settleTimer.current)
      settleTimer.current = null
    }
  }, [cancelRefocusFrame])

  const setInputRef = useCallback(
    (el: HTMLInputElement | null): void => {
      inputRef.current = el
      clearInlineInputTimers()
      // Keyed remounts skip blur; composition ownership must not outlive the element.
      imeEnter.reset()
      if (!el) {
        return
      }

      submitted.current = false
      focusSettled.current = false

      // Schedule focus after any pending focus-restore from menu close
      focusFrame.current = requestAnimationFrame(() => {
        focusFrame.current = null
        if (inputRef.current !== el) {
          return
        }
        el.focus()
        if (inlineInput.type === 'rename' && inlineInput.existingName) {
          const dotIndex = inlineInput.existingName.lastIndexOf('.')
          if (dotIndex > 0) {
            el.setSelectionRange(0, dotIndex)
          } else {
            el.select()
          }
        }
        // Treat blur as intentional only after menu-close focus management settles.
        settleTimer.current = setTimeout(() => {
          settleTimer.current = null
          focusSettled.current = true
        }, 200)
      })
    },
    [clearInlineInputTimers, imeEnter, inlineInput.existingName, inlineInput.type]
  )

  const clearBlurTimeout = useCallback(() => {
    if (blurTimeout.current) {
      clearTimeout(blurTimeout.current)
      blurTimeout.current = null
    }
  }, [])

  const submit = useCallback(
    (value: string) => {
      if (submitted.current) {
        return
      }
      submitted.current = true
      clearBlurTimeout()
      onSubmit(value)
    },
    [onSubmit, clearBlurTimeout]
  )

  return (
    <div
      className="flex items-center w-full h-[26px] px-2 gap-1"
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      <span className="size-3 shrink-0" />
      {inlineInput.type === 'folder' ? (
        <FolderIcon open={false} className="size-3 shrink-0 text-muted-foreground" />
      ) : (
        <File className="size-3 shrink-0 text-muted-foreground" />
      )}
      <ContextMenu
        key={inlineInputKey}
        onOpenChange={(open) => {
          const request = ++menuRequest.current
          setClipboardText('')
          menuTarget.current = open ? inputRef.current : null
          if (open) {
            if (!menuSelection.current && inputRef.current) {
              captureInputSelection(inputRef.current)
            }
            clearBlurTimeout()
            cancelRefocusFrame()
            void window.api.ui
              .readClipboardText()
              .then((text) => {
                if (request === menuRequest.current && menuTarget.current === inputRef.current) {
                  setClipboardText(text)
                }
              })
              .catch(() => {})
          }
        }}
      >
        <ContextMenuTrigger asChild>
          <input
            ref={setInputRef}
            className="flex-1 min-w-0 bg-transparent text-xs text-foreground outline-none border border-ring rounded-sm px-1"
            defaultValue={inlineInput.type === 'rename' ? inlineInput.existingName : ''}
            onPointerDownCapture={(event) => {
              if (event.button === 2) {
                captureInputSelection(event.currentTarget)
              }
            }}
            onContextMenuCapture={(event) => {
              if (!menuSelection.current) {
                captureInputSelection(event.currentTarget)
              }
            }}
            onKeyDown={(e) => {
              // Leave composing keys, including the IME's Enter and Escape, to the input method.
              if (imeEnter.ownsKeyDown(e) || imeEnter.isComposing() || isImeCompositionKeyDown(e)) {
                return
              }
              if (e.key === 'Enter') {
                e.preventDefault()
                submit(e.currentTarget.value)
              } else if (e.key === 'Escape') {
                clearBlurTimeout()
                submitted.current = true
                onCancel()
              }
            }}
            onCompositionStart={() => imeEnter.setComposing(true)}
            onCompositionEnd={() => imeEnter.setComposing(false)}
            onFocus={clearBlurTimeout}
            onBlur={(e) => {
              imeEnter.reset()
              if (menuTarget.current === e.currentTarget) {
                return
              }
              // Refocus only during menu-close grace; afterward commit on blur, since relatedTarget cannot distinguish Radix cleanup from row clicks.
              if (!focusSettled.current) {
                scheduleInputRefocus()
                return
              }
              const value = e.currentTarget.value
              blurTimeout.current = setTimeout(() => {
                blurTimeout.current = null
                submit(value)
              }, 150)
            }}
          />
        </ContextMenuTrigger>
        <ContextMenuContent
          onCloseAutoFocus={(event) => {
            event.preventDefault()
            restoreInputSelection()
          }}
        >
          {clipboardText && (
            <FileExplorerPasteMenuItem
              preview={{ kind: 'text', text: clipboardText }}
              onSelect={() => {
                restoreInputSelection()
                if (inputRef.current) {
                  void pasteTextIntoTextControl(inputRef.current, clipboardText)
                }
              }}
            />
          )}
          <ContextMenuItem
            onSelect={() => {
              menuSelection.current = null
              inputRef.current?.select()
            }}
          >
            {t('auto.components.right.sidebar.FileExplorerPaste.selectAll', 'Select All')}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    </div>
  )
}
