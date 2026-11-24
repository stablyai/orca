import { useEffect, useRef, useState } from 'react'
import {
  Braces,
  Copy,
  FileSearch,
  ListTree,
  Navigation,
  Pencil,
  Scissors,
  ClipboardPaste
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import {
  useCodeIntelligenceStore,
  type CodeContextMenuRequest
} from '@/store/code-intelligence/use-code-intelligence-store'

const MENU_SHORTCUTS = {
  definition: 'Ctrl+B',
  typeDefinition: 'Ctrl+Shift+B',
  implementation: 'Ctrl+Alt+B',
  references: 'Shift+F12',
  rename: 'F2',
  outline: 'Ctrl+F12',
  cut: 'Ctrl+X',
  copy: 'Ctrl+C',
  paste: 'Ctrl+V',
  selectAll: 'Ctrl+A'
} as const

export function CodeEditorContextMenu({
  menu,
  onRunCommand,
  onClose
}: {
  menu: CodeContextMenuRequest
  onRunCommand: (command: 'cut' | 'copy' | 'paste' | 'select-all') => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const panelRef = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState({ x: menu.x, y: menu.y })
  const runGoto = useCodeIntelligenceStore((s) => s.runGoto)
  const runFindReferences = useCodeIntelligenceStore((s) => s.runFindReferences)
  const openOutline = useCodeIntelligenceStore((s) => s.openOutline)
  const beginRename = useCodeIntelligenceStore((s) => s.beginRename)

  useEffect(() => {
    const rect = panelRef.current?.getBoundingClientRect()
    if (!rect) {
      return
    }
    setCoords({
      x: Math.max(8, Math.min(menu.x, window.innerWidth - rect.width - 8)),
      y: Math.max(8, Math.min(menu.y, window.innerHeight - rect.height - 8))
    })
  }, [menu.x, menu.y])

  useEffect(() => {
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !panelRef.current?.contains(e.target)) {
        onClose()
      }
    }
    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown, true)
    window.addEventListener('blur', onClose)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown, true)
      window.removeEventListener('blur', onClose)
    }
  }, [onClose])

  const navPayload = {
    filePath: menu.filePath,
    workspaceRoot: menu.workspaceRoot,
    language: menu.language,
    text: menu.text,
    line: menu.line,
    column: menu.column,
    word: menu.word,
    anchor: { x: menu.x, y: menu.y }
  }

  return (
    <div
      ref={panelRef}
      role="menu"
      data-code-context-menu="true"
      style={{ left: coords.x, top: coords.y }}
      className="fixed z-50 min-w-56 overflow-hidden rounded-lg border border-border bg-popover p-1 text-popover-foreground shadow-lg"
    >
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          void runGoto({ ...navPayload, kind: 'definition' })
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <Navigation className="size-3.5 text-primary" />
          {t('auto.components.editor.codeIntelligence.goToDefinition', 'Go to Definition')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {MENU_SHORTCUTS.definition}
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          void runGoto({ ...navPayload, kind: 'typeDefinition' })
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <Braces className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.goToTypeDefinition', 'Go to Type Definition')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {MENU_SHORTCUTS.typeDefinition}
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          void runGoto({ ...navPayload, kind: 'implementation' })
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <Braces className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.goToImplementation', 'Go to Implementation')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {MENU_SHORTCUTS.implementation}
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          void runFindReferences(navPayload)
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <FileSearch className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.findReferences', 'Find References')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {MENU_SHORTCUTS.references}
        </span>
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={menu.readOnly}
        onClick={() => {
          onClose()
          void beginRename(navPayload)
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-45"
      >
        <span className="flex items-center gap-2">
          <Pencil className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.renameSymbol', 'Rename Symbol')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{MENU_SHORTCUTS.rename}</span>
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          void openOutline({
            filePath: menu.filePath,
            workspaceRoot: menu.workspaceRoot,
            language: menu.language,
            text: menu.text
          })
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="flex items-center gap-2">
          <ListTree className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.fileStructure', 'File Structure')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {MENU_SHORTCUTS.outline}
        </span>
      </button>

      <div className="my-1 border-t border-border/70" />

      <button
        type="button"
        role="menuitem"
        disabled={menu.readOnly || !menu.hasSelection}
        onClick={() => {
          onClose()
          onRunCommand('cut')
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-45"
      >
        <span className="flex items-center gap-2">
          <Scissors className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.cut', 'Cut')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{MENU_SHORTCUTS.cut}</span>
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={!menu.hasSelection}
        onClick={() => {
          onClose()
          onRunCommand('copy')
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-45"
      >
        <span className="flex items-center gap-2">
          <Copy className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.copy', 'Copy')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{MENU_SHORTCUTS.copy}</span>
      </button>

      <button
        type="button"
        role="menuitem"
        disabled={menu.readOnly}
        onClick={() => {
          onClose()
          onRunCommand('paste')
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground disabled:opacity-45"
      >
        <span className="flex items-center gap-2">
          <ClipboardPaste className="size-3.5 text-muted-foreground" />
          {t('auto.components.editor.codeIntelligence.paste', 'Paste')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">{MENU_SHORTCUTS.paste}</span>
      </button>

      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onClose()
          onRunCommand('select-all')
        }}
        className="flex w-full items-center justify-between gap-4 rounded px-2 py-1 text-xs hover:bg-accent hover:text-accent-foreground"
      >
        <span className="pl-5">
          {t('auto.components.editor.codeIntelligence.selectAll', 'Select All')}
        </span>
        <span className="font-mono text-[10px] text-muted-foreground">
          {MENU_SHORTCUTS.selectAll}
        </span>
      </button>
    </div>
  )
}
