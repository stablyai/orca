import { useState } from 'react'
import { ChevronDown, ChevronRight, Eye, Pencil } from 'lucide-react'
import { useDebugSessionStore, type DebugVariable } from '@/store/debug/use-debug-session-store'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useTranslate } from '@/i18n/use-translate'

export function DebugVariableTreeRows({
  variables,
  containerRef = 0,
  depth = 0
}: {
  variables: readonly DebugVariable[]
  containerRef?: number
  depth?: number
}): React.JSX.Element {
  const t = useTranslate()
  const variablesByRef = useDebugSessionStore((s) => s.variablesByRef)
  const expandVariables = useDebugSessionStore((s) => s.expandVariables)
  const capabilities = useDebugSessionStore((s) => s.capabilities)
  const setVariable = useDebugSessionStore((s) => s.setVariable)
  const addWatch = useDebugSessionStore((s) => s.addWatch)
  const [expandedRefs, setExpandedRefs] = useState<Record<number, boolean>>({})
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [draftValue, setDraftValue] = useState('')

  const canEditValues = Boolean(capabilities?.setValue)

  return (
    <div className="flex flex-col">
      {variables.map((v) => {
        const canExpand = v.variablesReference > 0
        const isOpen = Boolean(expandedRefs[v.variablesReference])
        const children = canExpand ? variablesByRef[v.variablesReference] : undefined
        const rowKey = `${containerRef}-${v.name}-${v.variablesReference}`
        const isEditing = editingKey === rowKey
        const watchExpr = v.evaluateName ?? v.name

        return (
          <div key={rowKey}>
            <div
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              className="group flex items-center gap-1.5 py-0.5 pr-2 font-mono text-[11px] hover:bg-accent/50"
            >
              {canExpand ? (
                <button
                  type="button"
                  onClick={() => {
                    const next = !isOpen
                    setExpandedRefs((prev) => ({ ...prev, [v.variablesReference]: next }))
                    if (next && !children) {
                      void expandVariables(v.variablesReference)
                    }
                  }}
                  className="text-muted-foreground hover:text-foreground"
                >
                  {isOpen ? (
                    <ChevronDown className="size-3" />
                  ) : (
                    <ChevronRight className="size-3" />
                  )}
                </button>
              ) : (
                <span className="inline-block w-3 shrink-0" />
              )}

              <span className="text-workflow-progress">{v.name}:</span>

              {isEditing ? (
                <input
                  type="text"
                  autoFocus
                  value={draftValue}
                  onChange={(e) => setDraftValue(e.target.value)}
                  onBlur={() => setEditingKey(null)}
                  onKeyDown={(e) => {
                    if (isImeOwnedKeyboardEvent(e)) {
                      return
                    }
                    if (e.key === 'Escape') {
                      setEditingKey(null)
                      return
                    }
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      const nextVal = draftValue
                      setEditingKey(null)
                      void setVariable(containerRef, v.name, nextVal, v.evaluateName)
                    }
                  }}
                  className="min-w-0 flex-1 rounded border border-primary bg-background px-1 py-0 font-mono text-[11px] text-foreground outline-none"
                />
              ) : (
                <span
                  className="min-w-0 truncate text-foreground"
                  onDoubleClick={() => {
                    if (!canEditValues || (containerRef <= 0 && !v.evaluateName)) {
                      return
                    }
                    setEditingKey(rowKey)
                    setDraftValue(v.value)
                  }}
                >
                  {v.value}
                </span>
              )}

              <span className="ml-auto flex shrink-0 items-center gap-1">
                {canEditValues && (containerRef > 0 || v.evaluateName) && !isEditing ? (
                  <button
                    type="button"
                    title={t('auto.components.editor.debug.editVariableValue', 'Set Value')}
                    onClick={() => {
                      setEditingKey(rowKey)
                      setDraftValue(v.value)
                    }}
                    className="hidden text-muted-foreground group-hover:inline-flex hover:text-foreground"
                  >
                    <Pencil className="size-2.5" />
                  </button>
                ) : null}
                {watchExpr ? (
                  <button
                    type="button"
                    title={t('auto.components.editor.debug.addWatchTitle', 'Add to Watches')}
                    onClick={() => void addWatch(watchExpr)}
                    className="hidden text-muted-foreground group-hover:inline-flex hover:text-foreground"
                  >
                    <Eye className="size-2.5" />
                  </button>
                ) : null}
                {v.typeName ? (
                  <span className="text-[10px] text-muted-foreground">{v.typeName}</span>
                ) : null}
              </span>
            </div>

            {canExpand && isOpen && children ? (
              <DebugVariableTreeRows
                variables={children}
                containerRef={v.variablesReference}
                depth={depth + 1}
              />
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
