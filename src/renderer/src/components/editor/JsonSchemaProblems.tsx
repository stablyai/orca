import { useEffect, useState } from 'react'
import type { editor } from 'monaco-editor'
import { monaco } from '@/lib/monaco-setup'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { translate } from '@/i18n/i18n'

export function JsonSchemaProblems({
  editor: instance
}: {
  editor: editor.IStandaloneCodeEditor | null
}): React.JSX.Element | null {
  const [markers, setMarkers] = useState<editor.IMarker[]>([])
  useEffect(() => {
    const refresh = (): void => {
      const model = instance?.getModel()
      setMarkers(
        model?.getLanguageId() === 'json'
          ? monaco.editor
              .getModelMarkers({ resource: model.uri })
              .filter((marker) => marker.owner === 'json')
          : []
      )
    }
    refresh()
    const changed = monaco.editor.onDidChangeMarkers(refresh)
    const modelChanged = instance?.onDidChangeModel(refresh)
    return () => {
      changed.dispose()
      modelChanged?.dispose()
    }
  }, [instance])
  if (!markers.length) {
    return null
  }
  return (
    <div className="absolute right-2 bottom-2 z-10">
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" size="sm">
            {translate('editor.jsonSchemaProblems', 'JSON problems')} ({markers.length})
          </Button>
        </PopoverTrigger>
        <PopoverContent side="top" align="end" className="w-96">
          <ul className="max-h-64 overflow-y-auto scrollbar-sleek space-y-1">
            {markers.slice(0, 100).map((marker) => (
              <li key={`${marker.startLineNumber}:${marker.startColumn}:${marker.message}`}>
                <Button
                  variant="ghost"
                  className="h-auto w-full justify-start whitespace-normal text-left"
                  onClick={() => {
                    instance?.revealLineInCenter(marker.startLineNumber)
                    instance?.setPosition({
                      lineNumber: marker.startLineNumber,
                      column: marker.startColumn
                    })
                    instance?.focus()
                  }}
                >
                  {marker.startLineNumber}:{marker.startColumn} {marker.message}
                </Button>
              </li>
            ))}
          </ul>
        </PopoverContent>
      </Popover>
    </div>
  )
}
