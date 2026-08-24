import React from 'react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import { useAppStore } from '@/store'
import { useLspStatusForFile } from '@/lib/monaco-lsp/monaco-lsp-status'

/** Language-server indicator for the active editor file: hidden when no
 *  server is attached, amber while starting, emerald with the server name
 *  (e.g. tsgo) once running. */
export function LspStatusSegment({ iconOnly }: { iconOnly: boolean }): React.JSX.Element | null {
  const activeFilePath = useAppStore(
    (s) => s.openFiles.find((file) => file.id === s.activeFileId)?.filePath ?? null
  )
  const status = useLspStatusForFile(activeFilePath)
  if (!status) {
    return null
  }
  const starting = status.state === 'starting'
  const serverLabel = status.serverId ?? 'LSP'
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span className="flex cursor-default select-none items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            className={cn(
              'size-1.5 rounded-full',
              starting ? 'animate-pulse bg-amber-500' : 'bg-emerald-500'
            )}
          />
          {iconOnly
            ? null
            : starting
              ? translate('auto.components.status.bar.LspStatusSegment.badge', 'LSP')
              : serverLabel}
        </span>
      </TooltipTrigger>
      <TooltipContent side="top" sideOffset={6}>
        {starting
          ? translate(
              'auto.components.status.bar.LspStatusSegment.starting',
              'Language server starting…'
            )
          : `${translate(
              'auto.components.status.bar.LspStatusSegment.running',
              'Language server'
            )}: ${serverLabel}`}
      </TooltipContent>
    </Tooltip>
  )
}
