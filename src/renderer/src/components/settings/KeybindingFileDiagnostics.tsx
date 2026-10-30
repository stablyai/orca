import React from 'react'
import type { KeybindingFileDiagnostic } from '../../../../shared/keybindings'
import { keybindingDiagnosticText } from './keybinding-diagnostic-text'

export function KeybindingFileDiagnostics({
  diagnostics
}: {
  diagnostics: readonly KeybindingFileDiagnostic[]
}): React.JSX.Element | null {
  if (diagnostics.length === 0) {
    return null
  }
  return (
    <div className="space-y-1">
      {diagnostics.map((diagnostic, index) => (
        <p
          key={`${diagnostic.section ?? 'root'}-${diagnostic.actionId ?? index}`}
          className={
            diagnostic.severity === 'error'
              ? 'text-xs text-destructive'
              : 'text-xs text-muted-foreground'
          }
        >
          {keybindingDiagnosticText(diagnostic)}
        </p>
      ))}
    </div>
  )
}
