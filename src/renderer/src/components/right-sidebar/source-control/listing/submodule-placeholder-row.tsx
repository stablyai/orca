import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { translate } from '@/i18n/i18n'
import {
  SOURCE_CONTROL_TREE_FILE_PADDING_PX,
  SOURCE_CONTROL_TREE_INDENT_PX,
  SUBMODULE_EMPTY_LABEL,
  SUBMODULE_ERROR_LABEL,
  SUBMODULE_LOADING_LABEL
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
  const fallback =
    state === 'error'
      ? SUBMODULE_ERROR_LABEL
      : state === 'empty'
        ? SUBMODULE_EMPTY_LABEL
        : state === 'truncated'
          ? translate(
              'auto.components.right.sidebar.SourceControl.submoduleTruncated',
              'More submodule changes were omitted'
            )
          : SUBMODULE_LOADING_LABEL
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
