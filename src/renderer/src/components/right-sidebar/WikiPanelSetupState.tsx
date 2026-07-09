import React from 'react'
import { BookText, Loader2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'

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
        <p className="text-sm text-muted-foreground">Generating the wiki…</p>
        {generatingOutput ? (
          <pre className="scrollbar-sleek max-h-40 w-full overflow-auto rounded bg-muted p-2 text-left text-xs text-muted-foreground whitespace-pre-wrap">
            {generatingOutput}
          </pre>
        ) : null}
        <Button variant="outline" size="sm" onClick={onStop}>
          Stop
        </Button>
      </div>
    )
  }

  if (phase === 'error') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
        <p className="text-sm text-muted-foreground">
          {errorMessage ?? 'Failed to load the wiki.'}
        </p>
        <Button variant="outline" size="sm" onClick={onGenerate}>
          Generate wiki
        </Button>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-3 px-6 text-center">
      <BookText className="size-7 text-muted-foreground" />
      <p className="text-sm text-muted-foreground">No wiki yet for this repository.</p>
      <label className="flex cursor-pointer items-center gap-2 text-sm text-muted-foreground">
        <Checkbox
          checked={addClaudeMd}
          onCheckedChange={(value) => onAddClaudeMdChange(value === true)}
        />
        Add wiki instruction to CLAUDE.md
      </label>
      <Button size="sm" onClick={onGenerate}>
        Generate wiki
      </Button>
    </div>
  )
}
