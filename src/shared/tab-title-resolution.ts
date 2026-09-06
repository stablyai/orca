import type { Tab } from './tab-types'
import type { TerminalTab } from './terminal-tab-types'
import { isMeaningfulOpenCodeTerminalTitle } from './opencode-terminal-title'

type NativeTerminalTitleMetadata = Partial<Pick<TerminalTab, 'defaultTitle' | 'launchAgent'>>

const UUID_TITLE_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i

function isPreferredNativeTerminalTitle(
  title: string,
  metadata: NativeTerminalTitleMetadata
): boolean {
  if (isMeaningfulOpenCodeTerminalTitle(title)) {
    return true
  }
  if (metadata.launchAgent !== 'trae') {
    return false
  }
  const defaultTitle = metadata.defaultTitle?.trim()
  return title !== defaultTitle && !/^Terminal \d+$/.test(title) && !UUID_TITLE_PATTERN.test(title)
}

export function resolveTerminalTabTitle(
  tab: Pick<
    TerminalTab,
    | 'customTitle'
    | 'quickCommandLabel'
    | 'aiVaultTitle'
    | 'generatedTitle'
    | 'title'
    | 'defaultTitle'
    | 'launchAgent'
  >,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveTitle = tab.title?.trim() ?? ''
  return (
    tab.customTitle?.trim() ||
    tab.quickCommandLabel?.trim() ||
    (isPreferredNativeTerminalTitle(liveTitle, tab) ? liveTitle : '') ||
    tab.aiVaultTitle?.title.trim() ||
    (generatedTitlesEnabled ? tab.generatedTitle?.trim() : '') ||
    liveTitle ||
    fallback
  )
}

export function resolveUnifiedTabLabel(
  tab:
    | (Pick<
        Tab,
        'customLabel' | 'quickCommandLabel' | 'aiVaultTitle' | 'generatedLabel' | 'label'
      > &
        NativeTerminalTitleMetadata)
    | undefined,
  generatedTitlesEnabled: boolean,
  fallback = ''
): string {
  const liveLabel = tab?.label?.trim() ?? ''
  return (
    tab?.customLabel?.trim() ||
    tab?.quickCommandLabel?.trim() ||
    (isPreferredNativeTerminalTitle(liveLabel, tab ?? {}) ? liveLabel : '') ||
    tab?.aiVaultTitle?.title.trim() ||
    (generatedTitlesEnabled ? tab?.generatedLabel?.trim() : '') ||
    liveLabel ||
    fallback
  )
}
