import { useBrowserAnnotateToolSwitch } from './use-browser-annotate-tool-switch'
import { browserPageDocumentIdentity } from './browser-page-document-identity'
import { useBrowserGrabShortcuts } from '../use-browser-grab-shortcuts'

type ToolSwitchArgs = Parameters<typeof useBrowserAnnotateToolSwitch>[0]
type ShortcutArgs = Parameters<typeof useBrowserGrabShortcuts>[0]

/** A browser page's annotate tools: the palette's tool switch and the keys that drive it. */
export function useBrowserPageAnnotateTools({
  grab,
  grabAnnotations,
  markup,
  browserTab,
  documentGeneration,
  isBlankTab,
  isActive,
  workspaceId,
  chromeShortcutScope
}: {
  grab: ToolSwitchArgs['grab']
  grabAnnotations: {
    grabIntent: ToolSwitchArgs['grabIntent']
    startGrabIntent: ToolSwitchArgs['startGrabIntent']
    cancelPendingBrowserCapture: ToolSwitchArgs['cancelPendingBrowserCapture']
    handleGrabActionShortcut: ShortcutArgs['handleGrabActionShortcut']
  }
  markup: ToolSwitchArgs['markup']
  browserTab: { id: string; loading: boolean; loadError?: unknown }
  documentGeneration: number
  isBlankTab: boolean
  isActive: boolean
  workspaceId: ShortcutArgs['workspaceId']
  chromeShortcutScope: ShortcutArgs['chromeShortcutScope']
}): ReturnType<typeof useBrowserAnnotateToolSwitch> {
  const canPickElements = !isBlankTab && !browserTab.loadError
  const toolSwitch = useBrowserAnnotateToolSwitch({
    grab,
    grabIntent: grabAnnotations.grabIntent,
    startGrabIntent: grabAnnotations.startGrabIntent,
    cancelPendingBrowserCapture: grabAnnotations.cancelPendingBrowserCapture,
    markup,
    canPickElements,
    toolTargetId: browserTab.id,
    ...browserPageDocumentIdentity(browserTab, documentGeneration)
  })
  useBrowserGrabShortcuts({
    transport: grab.transport,
    browserTabId: browserTab.id,
    workspaceId,
    chromeShortcutScope,
    markupIsActive: markup.isActive,
    toolsDisabled: !canPickElements,
    startGrabIntent: toolSwitch.toggleTool,
    handleGrabActionShortcut: grabAnnotations.handleGrabActionShortcut,
    grabIsInteractive: grab.state !== 'idle' && grab.state !== 'error',
    palette: {
      isActive,
      active: toolSwitch.activeTool !== null,
      onToolKey: toolSwitch.selectToolByKey
    }
  })
  return toolSwitch
}
