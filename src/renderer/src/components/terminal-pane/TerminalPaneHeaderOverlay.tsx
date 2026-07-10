import type { CSSProperties, RefObject } from 'react'
import { MessageSquare, SquareSplitVertical, SquareTerminal, X } from 'lucide-react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import type { PtyTransport } from './pty-transport'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'

export type PaneTitleOverlayRect = {
  left: number
  top: number
  width: number
}

type TerminalPaneHeaderOverlayProps = {
  tabId: string
  worktreeId: string
  cwd: string
  showAlwaysOnHeaders: boolean
  paneCount: number
  activePaneId: number | null | undefined
  panes: readonly ManagedPane[]
  paneTitles: Readonly<Record<number, string>>
  paneTitleOverlayRects: Readonly<Record<number, PaneTitleOverlayRect>>
  renamingPaneId: number | null
  renameValue: string
  renameInputRef: RefObject<HTMLInputElement | null>
  titleUsesLightSurface: boolean
  paneTitleBackground: string
  terminalContentVisible: boolean
  hiddenStartupStyle: CSSProperties
  managerRef: RefObject<PaneManager | null>
  paneTransportsRef: RefObject<Map<number, PtyTransport>>
  /** When true, this pane can toggle the native chat view; renders a chat/terminal
   *  toggle as the first button in the pane header actions row (beside split/close).
   *  The caller gates it to the active pane to avoid duplicating it across splits. */
  canToggleNativeChat?: boolean
  /** True when the active pane is currently showing the native chat view. */
  isChatViewMode?: boolean
  /** Flip the active pane between the terminal and the native chat view. */
  onToggleNativeChat?: () => void
  onSplitPane: (pane: ManagedPane, direction: 'vertical' | 'horizontal') => void
  onBeginPaneDrag: (paneId: number, handle: HTMLElement, event: PointerEvent) => void
  onActivatePaneTitleInteraction: (paneId: number) => void
  onPaneTitleContextMenu: (event: React.MouseEvent<HTMLElement>, paneId: number) => void
  onStartRename: (paneId: number) => void
  onRemoveTitle: (paneId: number) => void
  onClosePane: (paneId: number) => void
  onRenameValueChange: (value: string) => void
  onRenameSubmit: () => void
  onRenameCancel: () => void
  onRenameBlur: () => void
}

export default function TerminalPaneHeaderOverlay({
  tabId,
  worktreeId,
  cwd,
  showAlwaysOnHeaders,
  paneCount,
  activePaneId,
  panes,
  paneTitles,
  paneTitleOverlayRects,
  renamingPaneId,
  renameValue,
  renameInputRef,
  titleUsesLightSurface,
  paneTitleBackground,
  terminalContentVisible,
  hiddenStartupStyle,
  managerRef,
  paneTransportsRef,
  canToggleNativeChat,
  isChatViewMode,
  onToggleNativeChat,
  onSplitPane,
  onBeginPaneDrag,
  onActivatePaneTitleInteraction,
  onPaneTitleContextMenu,
  onStartRename,
  onRemoveTitle,
  onClosePane,
  onRenameValueChange,
  onRenameSubmit,
  onRenameCancel,
  onRenameBlur
}: TerminalPaneHeaderOverlayProps): React.JSX.Element {
  const splitRightLabel = translate(
    'auto.components.terminal.pane.TerminalContextMenu.20e565d865',
    'Split Terminal Right'
  )

  return (
    <div
      className="pane-title-overlay-layer"
      data-pane-title-surface={titleUsesLightSurface ? 'light' : 'dark'}
      style={{
        display: terminalContentVisible ? undefined : 'none',
        ['--orca-pane-title-bg' as string]: paneTitleBackground,
        ...hiddenStartupStyle
      }}
    >
      {panes.map((pane) => {
        const title = paneTitles[pane.id]
        const isEditing = renamingPaneId === pane.id
        const overlayRect = paneTitleOverlayRects[pane.id]
        const isActivePane = activePaneId === pane.id
        const isChromeless = showAlwaysOnHeaders && !title && !isEditing
        const showHeader = overlayRect && (showAlwaysOnHeaders || Boolean(title) || isEditing)
        if (!showHeader || !overlayRect) {
          return null
        }

        return (
          <div
            key={`pane-title-${pane.leafId}`}
            className="pane-title-bar"
            data-native-file-drop-target="terminal"
            data-terminal-tab-id={tabId}
            data-pane-prevent-terminal-focus=""
            {...(isActivePane ? { 'data-active-pane': '' } : {})}
            {...(isChromeless ? { 'data-chromeless': '' } : {})}
            {...(isEditing ? { 'data-editing': '' } : {})}
            onPointerDownCapture={
              title || isEditing ? () => onActivatePaneTitleInteraction(pane.id) : undefined
            }
            onDragOver={(event) => {
              onActivatePaneTitleInteraction(pane.id)
              if (
                event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) ||
                event.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
              ) {
                event.preventDefault()
                event.dataTransfer.dropEffect = 'copy'
              }
            }}
            onDrop={(event) => {
              if (
                !event.dataTransfer.types.includes(WORKSPACE_FILE_PATH_MIME) &&
                !event.dataTransfer.types.includes(WORKSPACE_FILE_PATHS_MIME)
              ) {
                return
              }
              event.preventDefault()
              event.stopPropagation()
              onActivatePaneTitleInteraction(pane.id)
              const manager = managerRef.current
              if (!manager) {
                return
              }
              void handleInternalTerminalFileDrop({
                manager,
                paneTransports: paneTransportsRef.current,
                worktreeId,
                tabId,
                cwd,
                dataTransfer: event.dataTransfer,
                dropTarget: event.target
              })
            }}
            onContextMenuCapture={(event) => onPaneTitleContextMenu(event, pane.id)}
            style={{
              left: overlayRect.left,
              top: overlayRect.top,
              width: overlayRect.width
            }}
          >
            {isEditing ? (
              <input
                ref={renameInputRef}
                className="pane-title-input"
                aria-label={translate(
                  'auto.components.terminal.pane.TerminalPane.7dbbfcbecc',
                  'Pane title'
                )}
                placeholder={translate(
                  'auto.components.terminal.pane.TerminalPane.7dbbfcbecc',
                  'Pane title'
                )}
                value={renameValue}
                onChange={(event) => onRenameValueChange(event.target.value)}
                onKeyDown={(event) => {
                  // Why: an Enter that only confirms a CJK IME candidate must
                  // not commit the rename; wait for a non-composition Enter.
                  if (isImeCompositionKeyDown(event)) {
                    return
                  }
                  if (event.key === 'Enter') {
                    onRenameSubmit()
                  } else if (event.key === 'Tab') {
                    // Why: commit on Tab directly instead of relying on the
                    // browser advancing focus (which fires blur). Headless / no
                    // window-focus environments (xvfb, some SSH sessions) don't
                    // always move focus off the input, so the blur-driven commit
                    // never runs. Submitting closes the editor, so the default
                    // Tab focus move is moot and any follow-on blur is a no-op.
                    onRenameSubmit()
                  } else if (event.key === 'Escape') {
                    onRenameCancel()
                  }
                }}
                onBlur={onRenameBlur}
              />
            ) : (
              <>
                {paneCount > 1 && !isChromeless && (
                  <div
                    className="pane-title-drag-handle"
                    aria-hidden="true"
                    onPointerDown={(event) => {
                      onBeginPaneDrag(pane.id, event.currentTarget, event.nativeEvent)
                    }}
                  />
                )}
                {title ? (
                  <button
                    type="button"
                    className="pane-title-text"
                    onClick={() => onStartRename(pane.id)}
                    aria-label={translate(
                      'auto.components.terminal.pane.TerminalPane.cc5a2dc706',
                      'Edit pane title: {{value0}}',
                      { value0: title }
                    )}
                  >
                    {title}
                  </button>
                ) : null}
                <div className="pane-title-actions ml-auto flex shrink-0 items-center gap-0">
                  {canToggleNativeChat && isActivePane ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          // Same class as split so it shares the hover/active reveal
                          // and sits as a peer in the [chat][split][×] cluster.
                          className="pane-title-split-trigger"
                          aria-label={
                            isChatViewMode
                              ? translate(
                                  'components.native-chat.toggle.showTerminal',
                                  'Show terminal'
                                )
                              : translate(
                                  'components.native-chat.toggle.showChat',
                                  'Show chat view'
                                )
                          }
                          aria-pressed={isChatViewMode}
                          onClick={(event) => {
                            event.stopPropagation()
                            onToggleNativeChat?.()
                          }}
                        >
                          {isChatViewMode ? (
                            <SquareTerminal className="size-3" />
                          ) : (
                            <MessageSquare className="size-3" />
                          )}
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}>
                        {isChatViewMode
                          ? translate('components.native-chat.toggle.showTerminal', 'Show terminal')
                          : translate('components.native-chat.toggle.showChat', 'Show chat view')}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {showAlwaysOnHeaders ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="pane-title-split-trigger"
                          data-contextual-tour-target={
                            isActivePane ? 'terminal-pane-split-target' : undefined
                          }
                          aria-label={splitRightLabel}
                          onClick={(event) => {
                            event.stopPropagation()
                            onSplitPane(pane, 'vertical')
                          }}
                        >
                          <SquareSplitVertical className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}>
                        {splitRightLabel}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                  {title ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="pane-title-close"
                          onClick={(event) => {
                            event.stopPropagation()
                            onRemoveTitle(pane.id)
                          }}
                          aria-label={translate(
                            'auto.components.terminal.pane.TerminalPane.f984ab2a30',
                            'Remove pane title: {{value0}}',
                            { value0: title }
                          )}
                        >
                          <X className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}>
                        {translate(
                          'auto.components.terminal.pane.TerminalPane.ac112e9036',
                          'Remove title'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : paneCount > 1 && showAlwaysOnHeaders ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-xs"
                          className="pane-title-close"
                          onClick={(event) => {
                            event.stopPropagation()
                            onClosePane(pane.id)
                          }}
                          aria-label={translate(
                            'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
                            'Close Pane'
                          )}
                        >
                          <X className="size-3" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="bottom" sideOffset={4}>
                        {translate(
                          'auto.components.terminal.pane.TerminalContextMenu.8c17d6786d',
                          'Close Pane'
                        )}
                      </TooltipContent>
                    </Tooltip>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
