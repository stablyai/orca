import type { AppState } from '@/store/types'
import type { resolveTerminalPresentation } from './terminal-command-state'

type TerminalPresentationRequest = Parameters<
  Parameters<typeof window.api.ui.onCreateTerminal>[0]
>[0]

export function createTerminalPresentationTab(
  store: AppState,
  request: TerminalPresentationRequest,
  shouldActivate: boolean,
  terminalPresentation: ReturnType<typeof resolveTerminalPresentation>
): ReturnType<AppState['createTab']> {
  const {
    worktreeId,
    targetGroupId,
    shellOverride,
    ptyId,
    tabId,
    leafId,
    agentLaunchViewer,
    surfaceOwner,
    launchAgent,
    viewMode,
    split,
    cwd
  } = request
  return ptyId
    ? store.createTab(worktreeId, targetGroupId, shellOverride, {
        initialPtyId: ptyId,
        ...(tabId && leafId ? { layoutAlreadyAdmitted: true as const } : {}),
        activate:
          shouldActivate ||
          agentLaunchViewer === 'focus-window' ||
          agentLaunchViewer === 'focus-in-workspace',
        ...(surfaceOwner === false && terminalPresentation === 'background'
          ? { recordInteraction: false }
          : {}),
        ...(launchAgent ? { launchAgent } : {}),
        ...(viewMode ? { viewMode } : {}),
        ...(split &&
        !store.groupsByWorktree[worktreeId]?.some((group) => group.id === targetGroupId)
          ? {
              split: {
                sourceGroupId: split.besideGroupId,
                splitDirection: split.direction,
                activate: shouldActivate
              }
            }
          : {}),
        ...(cwd ? { startupCwd: cwd } : {}),
        // Why: CLI-spawned PTYs bake the pane key into env; adopt the same tab id so hook-event attribution keeps working.
        ...(tabId !== undefined ? { id: tabId } : {}),
        ...(leafId ? { initialLeafId: leafId } : {})
      })
    : store.createTab(
        worktreeId,
        targetGroupId,
        shellOverride,
        shouldActivate
          ? cwd
            ? { startupCwd: cwd }
            : undefined
          : {
              activate: false,
              recordInteraction: false,
              ...(cwd ? { startupCwd: cwd } : {})
            }
      )
}
