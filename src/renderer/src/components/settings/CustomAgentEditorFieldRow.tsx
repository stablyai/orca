import type { ReactNode } from 'react'
import { Label } from '@/components/ui/label'
import { cn } from '@/lib/utils'
import type { CustomAgentEditorFieldError } from './custom-agent-editor-copy'

type CustomAgentEditorFieldRowProps = {
  label: string
  htmlFor?: string
  description?: ReactNode
  error?: CustomAgentEditorFieldError
  errorId?: string
  children: ReactNode
}

/** Shared label/description/error scaffold so every editor control associates its
 *  error with a stable id the error summary can link to and focus. */
export function CustomAgentEditorFieldRow({
  label,
  htmlFor,
  description,
  error,
  errorId,
  children
}: CustomAgentEditorFieldRowProps): React.JSX.Element {
  return (
    <div className="space-y-2">
      <Label htmlFor={htmlFor}>{label}</Label>
      {children}
      {description ? <p className="text-xs text-muted-foreground">{description}</p> : null}
      {error ? (
        <p id={errorId} className={cn('text-xs font-medium text-destructive')}>
          {error.message}
        </p>
      ) : null}
    </div>
  )
}
