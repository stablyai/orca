import type { CSSProperties, RefObject } from 'react'
import type { ManagedPane, PaneManager } from '@/lib/pane-manager/pane-manager'
import { translate } from '@/i18n/i18n'
import { WORKSPACE_FILE_PATH_MIME, WORKSPACE_FILE_PATHS_MIME } from '@/lib/workspace-file-drag'
import { isImeCompositionKeyDown } from '@/lib/ime-composition-keyboard-event'
import type { PtyTransport } from './pty-transport'
import { handleInternalTerminalFileDrop } from './terminal-drop-handler'
import PaneTitleActions from './PaneTitleActions'

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
  /** Used by ephemeral one-off command terminals that omit the header affordance. */
  showSplitButton?: boolean
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
  /** When true, this pane can switch between the terminal and the native chat
   *  view; renders a chat/terminal toggle as the first button in the pane header
   *  actions row (beside split/close). The caller gates it to the active pane to
   *  avoid duplicating it across splits, and to bridge chat only — a structured
   *  session has no terminal underneath to switch to. */
  canToggleNativeChat?: boolean
  /** True when the active pane is currently showing the native chat view. */
  isChatViewMode?: boolean
  /** Flip the active pane between the terminal and the native chat view. */
  onToggleNativeChat?: () => void
  canContinueAgentSessionInNewSession?: boolean
  onContinueAgentSessionInNewSession?: (pane: ManagedPane) => void
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
  showSplitButton = true,
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
  canContinueAgentSessionInNewSession,
  onContinueAgentSessionInNewSession,
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
        const editTitleLabel = title
          ? translate(
              'auto.components.terminal.pane.TerminalPane.cc5a2dc706',
              'Edit pane title: {{value0}}',
              { value0: title }
            )
          : ''
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
            onPointerDown={(event) => {
              // Why: the bar itself is the drag-initiating surface. The title
              // text deliberately does NOT stop propagation — it's part of the
              // drag surface too (single click/drag drags; double-click
              // renames) — only the rename input and the action buttons opt
              // out, matching SortableTab.tsx's root-drag/child-stopPropagation
              // split.
              if (paneCount > 1 && !isEditing) {
                onBeginPaneDrag(pane.id, event.currentTarget, event.nativeEvent)
              }
            }}
            onDoubleClick={(event) => {
              // Why: beginPaneDragFromPointerDown calls handle.setPointerCapture()
              // on this bar (the `handle` it's given), which retargets every
              // subsequent mouse-compatibility event for that pointer — including
              // dblclick — to the bar itself, not whatever child was under the
              // cursor. A dblclick handler on the inner title text/span would
              // never receive it, so it has to live here instead.
              if (!title || isEditing) {
                return
              }
              event.stopPropagation()
              onStartRename(pane.id)
            }}
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
                // Why: stop the bar's own pointerdown from starting a pane drag
                // while the rename input is focused/being clicked into.
                onPointerDown={(event) => event.stopPropagation()}
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
                {title ? (
                  // Why: a plain drag surface (not a <button>) so click/drag
                  // isn't stolen from the bar; rename is on double-click (on
                  // the bar itself — see onDoubleClick above, pointer capture
                  // retargets there) plus tabIndex/role/Enter-Space so a
                  // keyboard-only user can still reach it.
                  <span
                    className="pane-title-text"
                    role="button"
                    tabIndex={0}
                    aria-label={editTitleLabel}
                    title={editTitleLabel}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        onStartRename(pane.id)
                      }
                    }}
                  >
                    {title}
                  </span>
                ) : null}
                <PaneTitleActions
                  pane={pane}
                  title={title}
                  isActivePane={isActivePane}
                  paneCount={paneCount}
                  showAlwaysOnHeaders={showAlwaysOnHeaders}
                  showSplitButton={showSplitButton}
                  splitRightLabel={splitRightLabel}
                  canContinueAgentSessionInNewSession={canContinueAgentSessionInNewSession}
                  onContinueAgentSessionInNewSession={onContinueAgentSessionInNewSession}
                  canToggleNativeChat={canToggleNativeChat}
                  isChatViewMode={isChatViewMode}
                  onToggleNativeChat={onToggleNativeChat}
                  onSplitPane={onSplitPane}
                  onRemoveTitle={onRemoveTitle}
                  onClosePane={onClosePane}
                />
              </>
            )}
          </div>
        )
      })}
    </div>
  )
}
