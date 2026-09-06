import { normalizeTerminalLayoutSnapshot } from '@/components/terminal-pane/layout-serialization'
import { sanitizeTerminalLayoutPaneTitles } from '@/lib/terminal-pane-title-sanitization'
import type { AppState } from '@/store/types'
import type { RuntimeMobileSessionSnapshotTab } from '../../../../shared/runtime-types'
import type { TerminalLayoutSnapshot } from '../../../../shared/terminal-tab-types'
import {
  isNativeChatTabWideFallbackSafe,
  nativeChatLaunchAgentForLeaf
} from '../../components/native-chat/native-chat-leaf-routing'
import type { MobileSessionWorktreeInputs } from './types'
import {
  isClaudeManagementTitle,
  isTerminalLeafId,
  makePaneKey,
  mobileTerminalSurfaceId,
  getRuntimeLeafIdsForTerminal,
  resolveMobileTabWideAgentHintLeafId,
  isUnifiedTabActiveInActiveGroup
} from './mobile-session-surfaces'
import { resolveRuntimeTerminalTitle } from './sync-projections'
import { resolveTerminalLayoutRoot } from '../remote-terminal-layout-resolution'

export function buildMobileTerminalSurfaceTabs(
  inputs: MobileSessionWorktreeInputs,
  terminal: NonNullable<AppState['tabsByWorktree'][string]>[number],
  unifiedTabId?: string
): RuntimeMobileSessionSnapshotTab[] {
  const capture = inputs.mountedSurfaceCaptureByTabId.get(terminal.id)
  const isDesktopTabActive = unifiedTabId
    ? isUnifiedTabActiveInActiveGroup(inputs, unifiedTabId)
    : inputs.activeTerminalTabId === terminal.id
  const savedLayout = inputs.terminalLayoutByTabId.get(terminal.id)
  const leafIds = getRuntimeLeafIdsForTerminal(capture, savedLayout)
  const launchAgentLeafId = resolveMobileTabWideAgentHintLeafId(capture, savedLayout)
  const activeLeafId = capture?.hasLiveActivePane
    ? capture.liveActiveLeafId
    : (savedLayout?.activeLeafId ?? leafIds[0] ?? null)
  const paneTitles = inputs.paneTitlesByTabId.get(terminal.id) ?? {}
  const sanitizedSavedLayout = savedLayout
    ? sanitizeTerminalLayoutPaneTitles(savedLayout, terminal)
    : undefined
  const savedPtyIdsByLeafId = sanitizedSavedLayout?.ptyIdsByLeafId ?? {}
  const liveLayoutRoot = capture?.liveLayoutRoot ?? null
  const parentLayout = normalizeTerminalLayoutSnapshot({
    // Live DOM is authoritative when mounted; use saved tree otherwise.
    root: resolveTerminalLayoutRoot({
      authoritativeRoot: liveLayoutRoot,
      existingRoot: sanitizedSavedLayout?.root,
      leafIds,
      onSynthesize: (leafCount) =>
        console.warn(
          `[sync-runtime-graph] synthesized parentLayout for ${leafCount} leaves with no live or saved tree`
        )
    }),
    activeLeafId,
    expandedLeafId: sanitizedSavedLayout?.expandedLeafId ?? null,
    ...(Object.keys(savedPtyIdsByLeafId).length > 0 ? { ptyIdsByLeafId: savedPtyIdsByLeafId } : {}),
    ...(sanitizedSavedLayout?.titlesByLeafId
      ? { titlesByLeafId: sanitizedSavedLayout.titlesByLeafId }
      : {})
  } satisfies TerminalLayoutSnapshot).snapshot

  return leafIds.map((leafId) => {
    const numericPaneId = capture?.numericPaneIdByLeafId.get(leafId) ?? null
    const ptyId =
      numericPaneId === null
        ? (savedPtyIdsByLeafId[leafId] ?? (leafIds.length === 1 ? terminal.ptyId : null))
        : (capture?.ptyIdByNumericPaneId.get(numericPaneId) ?? savedPtyIdsByLeafId[leafId] ?? null)
    const legacyPaneId = numericPaneId === null ? /^pane:(\d+)$/.exec(leafId)?.[1] : null
    const paneTitle =
      numericPaneId !== null
        ? paneTitles[numericPaneId]
        : legacyPaneId
          ? paneTitles[Number(legacyPaneId)]
          : undefined
    const leafTitle = paneTitle?.trim() || sanitizedSavedLayout?.titlesByLeafId?.[leafId]?.trim()
    const paneKey = isTerminalLeafId(leafId) ? makePaneKey(terminal.id, leafId) : null
    const tabWideFallbackSafe =
      isNativeChatTabWideFallbackSafe(parentLayout) && launchAgentLeafId === leafId
    const title = tabWideFallbackSafe
      ? resolveRuntimeTerminalTitle(
          terminal,
          inputs.generatedTitlesEnabled,
          leafTitle ?? terminal.title ?? 'Terminal'
        )
      : (leafTitle ?? 'Terminal')
    const agentStatusTitle = leafTitle ?? (tabWideFallbackSafe ? terminal.title : '') ?? ''
    const agentStatus =
      paneKey && !isClaudeManagementTitle(agentStatusTitle)
        ? inputs.agentStatusByPaneKey.get(paneKey)
        : undefined
    const launchAgent = nativeChatLaunchAgentForLeaf({
      launchAgent: terminal.launchAgent,
      launchAgentLeafId,
      leafId,
      leafIds
    })
    const launchDraft = paneKey ? inputs.launchDraftByPaneKey.get(paneKey) : undefined
    const publishedLaunchDraft =
      launchDraft && launchDraft.agent === launchAgent && launchDraft.text.trim()
        ? launchDraft
        : null
    return {
      type: 'terminal' as const,
      id: mobileTerminalSurfaceId(terminal.id, leafId),
      title,
      ...(tabWideFallbackSafe && terminal.quickCommandLabel?.trim()
        ? { quickCommandLabel: terminal.quickCommandLabel.trim() }
        : {}),
      parentTabId: terminal.id,
      leafId,
      ptyId,
      ...(inputs.terminalTheme ? { terminalTheme: inputs.terminalTheme } : {}),
      ...(agentStatus ? { agentStatus } : {}),
      ...(launchAgent ? { launchAgent } : {}),
      ...(publishedLaunchDraft
        ? {
            launchDraft: publishedLaunchDraft.text,
            launchDraftCreatedAt: publishedLaunchDraft.createdAt
          }
        : {}),
      parentLayout,
      isActive: isDesktopTabActive && leafId === activeLeafId
    }
  })
}
