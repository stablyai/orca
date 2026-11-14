import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import {
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX,
  getSubmoduleEmptyLabel,
  getSubmoduleErrorLabel,
  getSubmoduleLoadingLabel
} from './row-layout'

export function SubmodulePlaceholderRow({
  depth,
  state,
  message
}: {
  depth: number
  state: 'loading' | 'empty' | 'error' | 'truncated'
  message?: string
}): React.JSX.Element {
  const t = useTranslate()
  const fallback =
    state === 'error'
      ? getSubmoduleErrorLabel(t)
      : state === 'empty'
        ? getSubmoduleEmptyLabel(t)
        : state === 'truncated'
          ? t(
              'auto.components.right.sidebar.SourceControl.submoduleTruncated',
              'More submodule changes were omitted'
            )
          : getSubmoduleLoadingLabel(t)
  return (
    <div
      className={cn(
        'flex items-center gap-1 pr-3 py-1 text-[11px]',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}
      style={{
        paddingLeft: `${depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_FILE_PADDING_PX}px`
      }}
    >
      {state === 'loading' && <Loader2 className="size-3 shrink-0 animate-spin" />}
      <span className="min-w-0 truncate">{message ?? fallback}</span>
    </div>
  )
}
