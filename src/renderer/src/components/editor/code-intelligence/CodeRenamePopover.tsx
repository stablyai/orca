import { useEffect, useRef, useState } from 'react'
import { Pencil, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import {
  useCodeIntelligenceStore,
  type CodeRenameRequest
} from '@/store/code-intelligence/use-code-intelligence-store'

export function CodeRenamePopover({
  request,
  onClose
}: {
  request: CodeRenameRequest
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [value, setValue] = useState(request.currentName)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const commitRename = useCodeIntelligenceStore((s) => s.commitRename)

  useEffect(() => {
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !panelRef.current?.contains(e.target)) {
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [onClose])

  const left = Math.max(
    12,
    Math.min(request.anchor.x, (typeof window !== 'undefined' ? window.innerWidth : 1200) - 340)
  )
  const top = Math.max(
    12,
    Math.min(request.anchor.y, (typeof window !== 'undefined' ? window.innerHeight : 800) - 120)
  )

  return (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t('auto.components.editor.codeIntelligence.renameSymbol', 'Rename Symbol')}
      data-code-rename-popover="true"
      style={{ left, top }}
      className="fixed z-50 flex w-80 flex-col gap-2 rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-xl"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          onClose()
        }
      }}
    >
      <div className="flex items-center justify-between gap-2 text-[11px]">
        <div className="flex items-center gap-1.5 font-medium text-foreground">
          <Pencil className="size-3 text-primary" />
          <span>{t('auto.components.editor.codeIntelligence.renameSymbol', 'Rename Symbol')}</span>
          <span className="rounded bg-muted px-1 py-0 text-[10px] text-muted-foreground">
            {request.lspAvailable
              ? t('auto.components.editor.codeIntelligence.renameScopeWorkspace', 'Workspace')
              : t('auto.components.editor.codeIntelligence.renameScopeCurrentFile', 'Current file')}
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t('auto.components.editor.codeIntelligence.cancelRename', 'Cancel rename')}
          className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X className="size-3" />
        </button>
      </div>

      <form
        className="flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          void commitRename(value)
        }}
      >
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="h-7 min-w-0 flex-1 rounded border border-border bg-background px-2 font-mono text-xs text-foreground outline-none focus:border-primary"
        />
        <Button type="submit" size="xs" variant="default">
          {t('auto.components.editor.codeIntelligence.applyAction', 'Apply')}
        </Button>
      </form>
    </div>
  )
}
