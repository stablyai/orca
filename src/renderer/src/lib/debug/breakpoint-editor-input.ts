import type { editor, IDisposable } from 'monaco-editor'
import type { DebugBreakpointFields } from '../../../../preload/api/debug-api'
import { translate } from '@/i18n/i18n'
import { isImeOwnedKeyboardEvent } from '@/lib/ime-composition-keyboard-event'
import type { BreakpointController } from './breakpoint-decorations'
import type { DebugMonaco } from './connect-debug-editor'

type InputKind = 'condition' | 'logMessage'

// Mirrors the Input primitive's surface; a content widget lives in Monaco's DOM, outside React.
const INPUT_CLASS =
  'h-7 w-80 max-w-full rounded-md border border-input bg-background px-2 text-xs text-foreground shadow-xs outline-none placeholder:text-muted-foreground/60 focus-visible:border-ring'

export function installBreakpointEditorInput(
  editorInstance: editor.IStandaloneCodeEditor,
  monaco: DebugMonaco,
  breakpoints: BreakpointController
): IDisposable {
  let widget: { close: (refocus: boolean) => void } | null = null

  const cursorLine = (): number | null => editorInstance.getPosition()?.lineNumber ?? null

  function openInput(line: number, kind: InputKind): void {
    widget?.close(false)
    const existing = breakpoints.at(line)
    const node = document.createElement('div')
    // A narrow split must not push the input past the editor's right edge.
    node.style.maxWidth = `${Math.max(160, editorInstance.getLayoutInfo().contentWidth - 24)}px`
    const input = document.createElement('input')
    input.className = INPUT_CLASS
    input.value = existing?.[kind] ?? ''
    input.placeholder =
      kind === 'condition'
        ? translate(
            'debug.breakpointInput.conditionPlaceholder',
            'Break when this expression is true'
          )
        : translate(
            'debug.breakpointInput.logPlaceholder',
            'Message to log; {expression} is interpolated'
          )
    input.setAttribute(
      'aria-label',
      kind === 'condition'
        ? translate('debug.breakpointInput.conditionLabel', 'Breakpoint condition')
        : translate('debug.breakpointInput.logLabel', 'Logpoint message')
    )
    node.appendChild(input)
    const contentWidget: editor.IContentWidget = {
      getId: () => 'orca.debug.breakpointInput',
      getDomNode: () => node,
      getPosition: () => ({
        position: { lineNumber: line, column: 1 },
        preference: [monaco.editor.ContentWidgetPositionPreference.BELOW]
      })
    }
    let closed = false
    const close = (refocus = true): void => {
      if (closed) {
        return
      }
      closed = true
      widget = null
      editorInstance.removeContentWidget(contentWidget)
      if (refocus) {
        editorInstance.focus()
      }
    }
    const save = (): void => {
      const value = input.value.trim()
      const current = breakpoints.at(line)
      // An empty value clears the field on an existing breakpoint and adds a plain one otherwise.
      const fields: DebugBreakpointFields = current || value ? { [kind]: value } : {}
      void (current ? breakpoints.update(current.id, fields) : breakpoints.add(line, fields))
      close()
    }
    input.addEventListener('keydown', (event) => {
      // Keep Monaco's keybindings (Enter, Backspace) from acting on the model.
      event.stopPropagation()
      if (isImeOwnedKeyboardEvent(event)) {
        return
      }
      if (event.key === 'Enter') {
        event.preventDefault()
        save()
      } else if (event.key === 'Escape') {
        event.preventDefault()
        close()
      }
    })
    input.addEventListener('blur', () => close())
    widget = { close }
    editorInstance.addContentWidget(contentWidget)
    input.focus()
  }

  const onLine = (run: (line: number) => void) => () => {
    const line = cursorLine()
    if (line !== null) {
      run(line)
    }
  }
  const withBreakpoint = (run: (id: string, enabled: boolean) => void) =>
    onLine((line) => {
      const bp = breakpoints.at(line)
      if (bp) {
        run(bp.id, bp.enabled)
      }
    })

  const actions: [string, string, () => void][] = [
    [
      'orca.debug.addConditionalBreakpoint',
      translate('debug.breakpointMenu.addConditional', 'Add Conditional Breakpoint…'),
      onLine((line) => openInput(line, 'condition'))
    ],
    [
      'orca.debug.addLogpoint',
      translate('debug.breakpointMenu.addLogpoint', 'Add Logpoint…'),
      onLine((line) => openInput(line, 'logMessage'))
    ],
    [
      'orca.debug.editBreakpoint',
      translate('debug.breakpointMenu.edit', 'Edit Breakpoint…'),
      onLine((line) => {
        const bp = breakpoints.at(line)
        if (bp) {
          openInput(line, bp.logMessage ? 'logMessage' : 'condition')
        }
      })
    ],
    [
      'orca.debug.toggleBreakpointEnabled',
      translate('debug.breakpointMenu.toggleEnabled', 'Enable/Disable Breakpoint'),
      withBreakpoint((id, enabled) => void breakpoints.update(id, { enabled: !enabled }))
    ],
    [
      'orca.debug.removeBreakpoint',
      translate('debug.breakpointMenu.remove', 'Remove Breakpoint'),
      withBreakpoint((id) => void breakpoints.remove(id))
    ]
  ]
  const registered = actions.map(([id, label, run], order) =>
    editorInstance.addAction({
      id,
      label,
      contextMenuGroupId: 'debug',
      contextMenuOrder: order + 1,
      run
    })
  )

  return {
    dispose: () => {
      widget?.close(false)
      registered.forEach((action) => action.dispose())
    }
  }
}
