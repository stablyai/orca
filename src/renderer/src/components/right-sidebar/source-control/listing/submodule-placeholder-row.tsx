import React from 'react'
import { Loader2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import { translate } from '@/i18n/i18n'
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
  message,
  refreshing,
  onRetry
}: {
  depth: number
  state: 'loading' | 'empty' | 'error' | 'truncated'
  message?: string
  refreshing?: boolean
  onRetry: () => void
}): React.JSX.Element {
  const fallback =
    state === 'error'
      ? getSubmoduleErrorLabel()
      : state === 'empty'
        ? getSubmoduleEmptyLabel()
        : state === 'truncated'
          ? translate(
              'auto.components.right.sidebar.SourceControl.submoduleTruncated',
              'More submodule changes were omitted'
            )
          : getSubmoduleLoadingLabel()
  return (
    <div
      className={cn(
        'flex items-center gap-1 pr-3 py-1 text-2xs',
        state === 'error' ? 'text-destructive' : 'text-muted-foreground'
      )}
      style={{
        paddingLeft: `${depth * SOURCE_CONTROL_TREE_INDENT_PX + SOURCE_CONTROL_TREE_FILE_PADDING_PX}px`
      }}
    >
      {state === 'loading' && <Loader2 className="size-3 shrink-0 animate-spin" />}
      <span className="min-w-0 truncate">{message || fallback}</span>
      {state === 'error' && (
        <Button type="button" variant="outline" size="xs" disabled={refreshing} onClick={onRetry}>
          {translate('auto.components.right.sidebar.SourceControl.286dbda4d6', 'Retry')}
        </Button>
      )}
    </div>
  )
}
