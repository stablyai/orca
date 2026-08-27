import type React from 'react'
import { useState } from 'react'
import Editor from '@monaco-editor/react'
import '@/lib/monaco-setup'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { translate } from '@/i18n/i18n'
import { THEME_PREVIEW_LANGUAGE_ID } from '@/lib/monaco-languages/register-theme-preview-language'

// Why: a short, syntax-rich snippet exercises comments, keywords, strings,
// functions, and types in one screenful — the same intent as the terminal's
// PREVIEW_BUFFER, adapted to a code editor.
const PREVIEW_SNIPPET = `// Editor color theme preview
import { fetchWorktrees } from './worktrees'

interface Worktree {
  id: string
  branch: string
  isDirty: boolean
}

async function loadActiveWorktree(id: string): Promise<Worktree> {
  const worktrees = await fetchWorktrees()
  return worktrees.find((tree) => tree.id === id) ?? worktrees[0]
}
`

type EditorColorThemePreviewProps = {
  title: string
  description?: string
  themeName: string
}

/** Read-only Monaco preview pane for the editor color theme picker — the
 *  editor-theme mirror of TerminalSettingsPreview.tsx. */
export function EditorColorThemePreview({
  title,
  description,
  themeName
}: EditorColorThemePreviewProps): React.JSX.Element {
  const [isEditorReady, setIsEditorReady] = useState(false)

  return (
    <Card className="gap-4 overflow-hidden py-0">
      <CardHeader className="gap-0 border-b border-border/50 px-4 py-3 !pb-3">
        <div className="min-w-0 space-y-1">
          <CardTitle className="text-sm">{title}</CardTitle>
          {description ? <CardDescription>{description}</CardDescription> : null}
        </div>
      </CardHeader>
      <CardContent className="px-4 pb-4">
        <div className="h-[220px] overflow-hidden rounded-md border border-border/50">
          <Editor
            height="100%"
            language={THEME_PREVIEW_LANGUAGE_ID}
            value={PREVIEW_SNIPPET}
            theme={themeName}
            onMount={() => setIsEditorReady(true)}
            options={{
              readOnly: true,
              domReadOnly: true,
              minimap: { enabled: false },
              lineNumbers: 'on',
              folding: false,
              scrollBeyondLastLine: false,
              renderLineHighlight: 'none',
              overviewRulerLanes: 0,
              contextmenu: false
            }}
            loading={
              <span className="text-xs text-muted-foreground">
                {translate(
                  'auto.components.settings.EditorColorThemePreview.loading',
                  'Loading preview…'
                )}
              </span>
            }
            // Why: hidden from a11y tree — this is a decorative live preview,
            // not an editable document; the real editor is elsewhere.
            wrapperProps={{ 'aria-hidden': !isEditorReady }}
          />
        </div>
      </CardContent>
    </Card>
  )
}
