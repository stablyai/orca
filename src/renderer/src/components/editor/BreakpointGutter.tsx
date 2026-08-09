import React, { useEffect, useRef, useState } from 'react'
import * as monaco from 'monaco-editor'
import type { editor } from 'monaco-editor'
import { useAppStore } from '@/store'
import {
  buildBreakpointDecorations,
  buildBreakpointHintDecoration
} from './monaco-breakpoint-decorations'
import { BreakpointGutterMenu } from './BreakpointGutterMenu'
import { BreakpointEditDialog, type BreakpointEditDialogFocusField } from './BreakpointEditDialog'

type BreakpointGutterProps = {
  editor: editor.IStandaloneCodeEditor | null
  filePath: string
}

type MenuState = { point: { x: number; y: number }; line: number }
type DialogState = { line: number; focusField: BreakpointEditDialogFocusField }

// Why: not GUTTER_GLYPH_MARGIN — Monaco collapses that lane to 0px until a decoration claims a
// lane, making it unclickable on a fresh file. linesDecorationsClassName renders into the
// always-reserved `lineDecorationsWidth` lane instead; see monaco-breakpoint-decorations.ts.
function isBreakpointGutterTarget(target: editor.IMouseTarget): boolean {
  return target.type === monaco.editor.MouseTargetType.GUTTER_LINE_DECORATIONS
}

export function BreakpointGutter({
  editor: editorInstance,
  filePath
}: BreakpointGutterProps): React.JSX.Element | null {
  const breakpoints = useAppStore((s) => s.getBreakpointsForPath(filePath))
  const toggleLineBreakpoint = useAppStore((s) => s.toggleLineBreakpoint)
  const upsertLineBreakpoint = useAppStore((s) => s.upsertLineBreakpoint)
  const removeBreakpoint = useAppStore((s) => s.removeBreakpoint)

  const breakpointDecorationsRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const hintDecorationRef = useRef<editor.IEditorDecorationsCollection | null>(null)
  const hintLineRef = useRef<number | null>(null)
  // Why: the mouse handlers close over this once at mount; a ref keeps them reading the live list without resubscribing on every toggle.
  const breakpointsRef = useRef(breakpoints)
  breakpointsRef.current = breakpoints

  const [menuState, setMenuState] = useState<MenuState | null>(null)
  const [dialogState, setDialogState] = useState<DialogState | null>(null)

  useEffect(() => {
    if (!editorInstance) {
      return
    }
    const decorations = buildBreakpointDecorations(breakpoints)
    if (!breakpointDecorationsRef.current) {
      breakpointDecorationsRef.current = editorInstance.createDecorationsCollection(decorations)
      return
    }
    breakpointDecorationsRef.current.set(decorations)
  }, [breakpoints, editorInstance])

  useEffect(() => {
    return () => {
      breakpointDecorationsRef.current?.clear()
      breakpointDecorationsRef.current = null
    }
  }, [editorInstance])

  useEffect(() => {
    if (!editorInstance) {
      return
    }

    const clearHint = (): void => {
      if (hintLineRef.current === null) {
        return
      }
      hintDecorationRef.current?.clear()
      hintLineRef.current = null
    }

    const onMouseMove = editorInstance.onMouseMove((e) => {
      const line = isBreakpointGutterTarget(e.target) ? (e.target.position?.lineNumber ?? null) : null
      if (line === null || breakpointsRef.current.some((bp) => bp.line === line)) {
        clearHint()
        return
      }
      if (hintLineRef.current === line) {
        return
      }
      hintLineRef.current = line
      const decoration = buildBreakpointHintDecoration(line)
      if (!hintDecorationRef.current) {
        hintDecorationRef.current = editorInstance.createDecorationsCollection([decoration])
      } else {
        hintDecorationRef.current.set([decoration])
      }
    })
    const onMouseLeave = editorInstance.onMouseLeave(clearHint)

    const onMouseDown = editorInstance.onMouseDown((e) => {
      if (!isBreakpointGutterTarget(e.target)) {
        return
      }
      const line = e.target.position?.lineNumber
      if (!line) {
        return
      }
      if (e.event.rightButton) {
        e.event.preventDefault()
        e.event.stopPropagation()
        setMenuState({ point: { x: e.event.posx, y: e.event.posy }, line })
        return
      }
      if (e.event.leftButton) {
        e.event.preventDefault()
        clearHint()
        toggleLineBreakpoint(filePath, line)
      }
    })

    return () => {
      onMouseMove.dispose()
      onMouseLeave.dispose()
      onMouseDown.dispose()
      hintDecorationRef.current?.clear()
      hintDecorationRef.current = null
      hintLineRef.current = null
    }
  }, [editorInstance, filePath, toggleLineBreakpoint])

  const menuLineBreakpoint = menuState
    ? breakpoints.find((bp) => bp.line === menuState.line)
    : undefined
  const dialogLineBreakpoint = dialogState
    ? breakpoints.find((bp) => bp.line === dialogState.line)
    : undefined

  return (
    <>
      {menuState && (
        <BreakpointGutterMenu
          open
          onOpenChange={(open) => {
            if (!open) {
              setMenuState(null)
            }
          }}
          point={menuState.point}
          hasBreakpoint={Boolean(menuLineBreakpoint)}
          onAddBreakpoint={() => {
            toggleLineBreakpoint(filePath, menuState.line)
            setMenuState(null)
          }}
          onAddConditional={() => {
            setDialogState({ line: menuState.line, focusField: 'condition' })
            setMenuState(null)
          }}
          onAddLogpoint={() => {
            setDialogState({ line: menuState.line, focusField: 'logMessage' })
            setMenuState(null)
          }}
          onEdit={() => {
            setDialogState({ line: menuState.line, focusField: 'condition' })
            setMenuState(null)
          }}
          onRemove={() => {
            if (menuLineBreakpoint) {
              removeBreakpoint(filePath, menuLineBreakpoint.id)
            }
            setMenuState(null)
          }}
        />
      )}
      {dialogState && (
        <BreakpointEditDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setDialogState(null)
            }
          }}
          line={dialogState.line}
          initialValue={dialogLineBreakpoint}
          focusField={dialogState.focusField}
          onSubmit={(draft) => {
            upsertLineBreakpoint(filePath, dialogState.line, draft)
            setDialogState(null)
          }}
        />
      )}
    </>
  )
}
