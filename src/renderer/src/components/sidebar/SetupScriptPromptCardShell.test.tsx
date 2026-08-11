// @vitest-environment happy-dom

import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { TooltipProvider } from '@/components/ui/tooltip'
import { SetupScriptPromptCardShell } from './SetupScriptPromptCardShell'

describe('SetupScriptPromptCardShell', () => {
  it('floats above its anchor without reserving a sidebar background panel', () => {
    const view = render(
      <TooltipProvider>
        <SetupScriptPromptCardShell
          repoBadgeColor="blue"
          repoDisplayName="orca"
          isInspectionError={false}
          sharedSetupIgnored={false}
          isPackageManagerSuggestion={false}
          hasCandidate={false}
          candidateSource={null}
          candidateProvenance={null}
          detectedSetupDraft=""
          isImporting={false}
          renderedStateOk
          onDismiss={vi.fn()}
          onRetryInspection={vi.fn()}
          onConfigure={vi.fn()}
          onImport={vi.fn()}
          onSetupDraftChange={vi.fn()}
        />
      </TooltipProvider>
    )
    const layer = view.container.querySelector('[data-setup-script-prompt-layer]')
    const surface = layer?.firstElementChild

    expect(layer?.classList.contains('absolute')).toBe(true)
    expect(layer?.classList.contains('inset-x-0')).toBe(true)
    expect(layer?.classList.contains('bottom-full')).toBe(true)
    expect(layer?.classList.contains('pointer-events-none')).toBe(true)
    expect(surface?.classList.contains('pointer-events-auto')).toBe(true)
    expect(surface?.classList.contains('bg-popover')).toBe(true)
    expect(surface?.classList.contains('text-popover-foreground')).toBe(true)
  })
})
