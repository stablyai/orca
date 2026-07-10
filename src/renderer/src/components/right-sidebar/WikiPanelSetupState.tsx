import React from 'react'
import { BookText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { translate } from '@/i18n/i18n'

/** Non-content phases the wiki panel can be in before a note is shown. */
export type WikiPanelSetupPhase = 'loading' | 'empty' | 'generating' | 'error'

type WikiPanelSetupStateProps = {
  phase: WikiPanelSetupPhase
  errorMessage: string | null
  addClaudeMd: boolean
  onAddClaudeMdChange: (value: boolean) => void
  generatingOutput: string
  onGenerate: () => void
  onStop: () => void
}

/** Renders the wiki panel's non-content states: loading spinner, generation progress, error, or the empty "generate wiki" prompt. */
export function WikiPanelSetupState({
  phase,
  errorMessage,
  addClaudeMd,
  onAddClaudeMdChange,
  generatingOutput,
  onGenerate,
  onStop
}: WikiPanelSetupStateProps): React.JSX.Element {
  if (phase === 'loading') {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        <Loader2 className="size-4 animate-spin" />
      </div>
    )
  }

  if (phase === 'generating') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <Loader2 className="size-7 animate-spin text-muted-foreground" />
        <p className="text-sm text-muted-foreground">
          {translate(
            'auto.components.right.sidebar.WikiPanelSetupState.ce26905ff1',
            'Generating the wiki…'
          )}
        </p>
        {generatingOutput ? (
          <pre className="scrollbar-sleek max-h-40 w-full overflow-auto rounded bg-muted p-2 text-left text-xs text-muted-foreground whitespace-pre-wrap">
            {generatingOutput}
          </pre>
        ) : null}
        <Button variant="outline" size="sm" onClick={onStop}>
          {translate('auto.components.right.sidebar.WikiPanelSetupState.7ee5702de8', 'Stop')}
        </Button>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          {errorMessage ??
            translate(
              'auto.components.right.sidebar.WikiPanelSetupState.36acee09c0',
              'Failed to load the wiki.'
            )}
        </p>
        <Button variant="outline" size="sm" onClick={onGenerate}>
          {translate(
            'auto.components.right.sidebar.WikiPanelSetupState.ea1ec65541',
            'Generate wiki'
          )}
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <BookText className="size-7 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">
        {translate(
          'auto.components.right.sidebar.WikiPanelSetupState.15a2d17d3c',
          'No wiki yet for this repository.'
        )}
      </p>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={addClaudeMd}
          onCheckedChange={(value) => onAddClaudeMdChange(value === true)}
        />
        {translate(
          'auto.components.right.sidebar.WikiPanelSetupState.eded43f086',
          'Add wiki instruction to CLAUDE.md'
        )}
      </label>
      <Button size="sm" onClick={onGenerate}>
        {translate('auto.components.right.sidebar.WikiPanelSetupState.ea1ec65541', 'Generate wiki')}
      </Button>
    </div>
  )
}
