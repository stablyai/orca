import { AlertCircle, Info, X } from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'
import { cn } from '@/lib/class-names'
import type { BreakpointPopoverRequest } from '../codemirror/breakpoint-gutter'
import type { DebugValueInspectRequest } from '../codemirror/debug-inline-values'
import { DebugBreakpointPopover } from '../debug/DebugBreakpointPopover'
import { DebugValueInspectPopover } from '../debug/DebugValueInspectPopover'
import { CodeEditorContextMenu } from './CodeEditorContextMenu'
import { CodeNavigationChooserPopover } from './CodeNavigationChooserPopover'
import { CodeOutlinePopover } from './CodeOutlinePopover'
import { CodeRenamePopover } from './CodeRenamePopover'

export function CodeIntelligenceOverlays({
  filePath,
  workspaceRoot,
  bpPopover,
  valueInspect,
  onCloseBpPopover,
  onCloseValueInspect,
  onRunContextCommand
}: {
  filePath: string
  workspaceRoot: string | null
  bpPopover: BreakpointPopoverRequest | null
  valueInspect: (DebugValueInspectRequest & { filePath: string }) | null
  onCloseBpPopover: () => void
  onCloseValueInspect: () => void
  onRunContextCommand: (command: 'cut' | 'copy' | 'paste' | 'select-all') => void
}): React.JSX.Element {
  const t = useTranslate()
  const chooser = useCodeIntelligenceStore((s) => s.chooser)
  const outline = useCodeIntelligenceStore((s) => s.outline)
  const renameRequest = useCodeIntelligenceStore((s) => s.renameRequest)
  const contextMenu = useCodeIntelligenceStore((s) => s.contextMenu)
  const statusHint = useCodeIntelligenceStore((s) => s.statusHint)
  const closeChooser = useCodeIntelligenceStore((s) => s.closeChooser)
  const closeOutline = useCodeIntelligenceStore((s) => s.closeOutline)
  const closeRename = useCodeIntelligenceStore((s) => s.closeRename)
  const closeContextMenu = useCodeIntelligenceStore((s) => s.closeContextMenu)
  const dismissStatusHint = useCodeIntelligenceStore((s) => s.dismissStatusHint)
  const activeBpPopover = bpPopover?.filePath === filePath ? bpPopover : null
  const activeValueInspect = valueInspect?.filePath === filePath ? valueInspect : null

  return (
    <>
      {chooser ? (
        <CodeNavigationChooserPopover
          chooser={chooser}
          workspaceRoot={workspaceRoot}
          onClose={closeChooser}
        />
      ) : null}
      {outline && outline.filePath === filePath ? (
        <CodeOutlinePopover outline={outline} onClose={closeOutline} />
      ) : null}
      {renameRequest && renameRequest.filePath === filePath ? (
        <CodeRenamePopover
          key={`${renameRequest.filePath}:${renameRequest.line}:${renameRequest.column}`}
          request={renameRequest}
          onClose={closeRename}
        />
      ) : null}
      {contextMenu && contextMenu.filePath === filePath ? (
        <CodeEditorContextMenu
          menu={contextMenu}
          onRunCommand={onRunContextCommand}
          onClose={closeContextMenu}
        />
      ) : null}
      {activeBpPopover ? (
        <DebugBreakpointPopover
          key={`${activeBpPopover.filePath}:${activeBpPopover.line}`}
          filePath={activeBpPopover.filePath}
          line={activeBpPopover.line}
          x={activeBpPopover.x}
          y={activeBpPopover.y}
          focusLog={activeBpPopover.focusLog}
          onClose={onCloseBpPopover}
        />
      ) : null}
      {activeValueInspect ? (
        <DebugValueInspectPopover
          expression={activeValueInspect.expression}
          variable={activeValueInspect.variable}
          x={activeValueInspect.x}
          y={activeValueInspect.y}
          onClose={onCloseValueInspect}
        />
      ) : null}
      {statusHint ? (
        <div
          role="status"
          className={cn(
            'fixed right-6 bottom-12 z-40 flex max-w-md items-center gap-2 rounded-md border px-3 py-1.5 text-xs shadow-lg',
            statusHint.tone === 'warning'
              ? 'border-status-warning-border bg-status-warning-background text-status-warning-foreground'
              : 'border-border bg-popover text-popover-foreground'
          )}
        >
          {statusHint.tone === 'warning' ? (
            <AlertCircle className="size-3.5 shrink-0 text-status-warning" />
          ) : (
            <Info className="size-3.5 shrink-0 text-primary" />
          )}
          <span className="truncate">{statusHint.text}</span>
          <button
            type="button"
            onClick={dismissStatusHint}
            aria-label={t('auto.components.editor.codeIntelligence.dismissHint', 'Dismiss hint')}
            className="rounded p-0.5 text-muted-foreground hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        </div>
      ) : null}
    </>
  )
}
