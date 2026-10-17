import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'
import { recognizeAgentCommandLine } from './agent-command-line-title'
import { formatAgentTypeLabel } from './agent-type-label'

export function resolveTerminalTabTitle(
  tab: Pick<
    TerminalTab,
    | 'customTitle'
    | 'quickCommandLabel'
    | 'aiVaultTitle'
    | 'generatedTitle'
    | 'title'
    | 'defaultTitle'
  >,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveTitle = tab.title?.trim() ?? ''
  const recognizedLiveCommandAgent = recognizeAgentCommandLine(liveTitle)
  const recognizedFallbackCommandAgent = liveTitle ? null : recognizeAgentCommandLine(fallback)
  const recognizedCommandAgent = recognizedLiveCommandAgent ?? recognizedFallbackCommandAgent
  const effectiveLiveTitle = recognizedLiveCommandAgent ? '' : liveTitle
  const effectiveFallback = recognizedFallbackCommandAgent ? '' : fallback

  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(effectiveLiveTitle) ? effectiveLiveTitle : '') ||
    tab.aiVaultTitle?.title.trim() ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    effectiveLiveTitle ||
    (recognizedCommandAgent ? formatAgentTypeLabel(recognizedCommandAgent.agent) : '') ||
    effectiveFallback ||
    tab.defaultTitle?.trim() ||
    ''
  )
}

export function resolveUnifiedTabLabel(
  tab:
    | Pick<Tab, 'customLabel' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedLabel' | 'label'>
    | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  const recognizedLiveCommandAgent = recognizeAgentCommandLine(liveLabel)
  const recognizedFallbackCommandAgent = liveLabel ? null : recognizeAgentCommandLine(fallback)
  const recognizedCommandAgent = recognizedLiveCommandAgent ?? recognizedFallbackCommandAgent
  const effectiveLiveLabel = recognizedLiveCommandAgent ? '' : liveLabel
  const effectiveFallback = recognizedFallbackCommandAgent ? '' : fallback

  return (
    tab?.customLabel?.trim() ||
    tab?.quickCommandLabel?.trim() ||
    (isMeaningfulOpenCodeTerminalTitle(effectiveLiveLabel) ? effectiveLiveLabel : '') ||
    tab?.aiVaultTitle?.title.trim() ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    effectiveLiveLabel ||
    (recognizedCommandAgent ? formatAgentTypeLabel(recognizedCommandAgent.agent) : '') ||
    effectiveFallback ||
    ''
  )
}
