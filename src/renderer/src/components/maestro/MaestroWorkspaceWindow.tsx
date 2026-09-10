import {
  FileCode2,
  Focus,
  Globe2,
  Link2,
  MonitorUp,
  TerminalSquare,
  TextCursorInput,
  Workflow,
  X
} from 'lucide-react'
import { useState } from 'react'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import { Button } from '@/components/ui/button'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import type { MaestroWorkspaceWindowPlacement } from './maestro-workspace-window-layout'
import { translate } from '@/i18n/i18n'
import type { MaestroWorkspacePresencePhase } from './maestro-workspace-presence'
import type { MaestroWorkspacePreviewMode } from './maestro-workspace-visibility'
import { MaestroWorkspaceSurfacePreview } from './MaestroWorkspaceSurfacePreview'
import { maestroTerminalSurfacePaneKey } from './maestro-agent-terminal-bindings'
import { resolveMaestroWorkspaceSurfaceTitle } from './maestro-workspace-surface-title'
import { MaestroWorkspaceInlineTitle } from './MaestroWorkspaceInlineTitle'
import { startMaestroWorkspaceWindowGesture } from './maestro-workspace-window-gesture'

export type MaestroWorkspaceWindowProps = {
  surfaceKey: string
  surface: WorkspaceSurface
  placement: MaestroWorkspaceWindowPlacement
  selected: boolean
  pending: boolean
  linkTarget: boolean
  runtimeTarget: RuntimeClientTarget
  // Canvas zoom, so screen-px drag deltas can be converted into world placement units.
  worldZoom?: number
  presencePhase?: MaestroWorkspacePresencePhase
  previewMode?: MaestroWorkspacePreviewMode
  agentFunctionLabel?: string
  agentTaskId?: string
  agentRole?: 'coordinator' | 'worker'
  onSelect: () => void
  onRename: (title: string) => void
  onLinkPointerDown: (event: React.PointerEvent<HTMLButtonElement>) => void
  onFocus: () => void
  onClose: () => Promise<void>
  onMoveCommit: (delta: { x: number; y: number }) => void
  onResizeCommit: (delta: { x: number; y: number }) => void
  onUpdateAnnotationContent?: (content: string) => void
}

const SURFACE_ICON = {
  terminal: TerminalSquare,
  browser: Globe2,
  editor: FileCode2,
  diff: FileCode2,
  'conflict-review': FileCode2,
  'check-details': FileCode2,
  simulator: MonitorUp
} as const

export function MaestroWorkspaceWindow({
  surfaceKey,
  surface,
  placement,
  selected,
  pending,
  linkTarget,
  runtimeTarget,
  worldZoom = 1,
  presencePhase = 'present',
  previewMode = 'full',
  agentFunctionLabel,
  agentTaskId,
  agentRole,
  onSelect,
  onRename,
  onLinkPointerDown,
  onFocus,
  onClose,
  onMoveCommit,
  onResizeCommit,
  onUpdateAnnotationContent
}: MaestroWorkspaceWindowProps): React.JSX.Element {
  const [focusTerminalOnMount, setFocusTerminalOnMount] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [closeRequested, setCloseRequested] = useState(false)
  const selectWithoutTerminalFocus = (): void => {
    setFocusTerminalOnMount(false)
    onSelect()
  }
  const Icon = SURFACE_ICON[surface.content_type]
  const normalizedFunction = agentFunctionLabel?.trim()
  const visibleTitle = resolveMaestroWorkspaceSurfaceTitle(
    surface.title,
    normalizedFunction,
    agentTaskId
  )
  const roleLabel =
    agentRole === 'coordinator'
      ? translate('auto.components.maestro.MaestroWorkspaceWindow.coordinator', 'Orchestrator')
      : agentRole === 'worker'
        ? translate('auto.components.maestro.MaestroWorkspaceWindow.worker', 'Worker')
        : null
  const functionLabel =
    normalizedFunction && normalizedFunction !== visibleTitle ? normalizedFunction : null
  const visiblePresencePhase = closeRequested ? 'exiting' : presencePhase
  const requestClose = (): void => {
    if (closeRequested) {
      return
    }
    setCloseRequested(true)
    void onClose().catch(() => setCloseRequested(false))
  }
  return (
    <ContextMenu onOpenChange={(open) => open && selectWithoutTerminalFocus()}>
      <ContextMenuTrigger asChild>
        <article
          className="maestro-workspace-window absolute flex overflow-visible rounded-xl border bg-card shadow-xs outline-none transition-[border-color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring"
          style={{
            left: placement.position.x,
            top: placement.position.y,
            width: placement.size.width,
            height: placement.size.height,
            zIndex: placement.z_order,
            borderColor: linkTarget
              ? 'var(--status-success)'
              : selected
                ? 'var(--ring)'
                : 'var(--border)'
          }}
          data-maestro-workspace-surface={surfaceKey}
          data-maestro-workspace-tab-id={surface.id.unified_tab_id}
          data-maestro-workspace-content-type={surface.content_type}
          data-maestro-browser-page-id={
            surface.binding.kind === 'browser' ? surface.binding.browser_page_id : undefined
          }
          data-maestro-link-target={linkTarget ? 'true' : undefined}
          data-availability={surface.availability}
          data-maestro-presence={visiblePresencePhase}
          data-maestro-preview-mode={previewMode}
          data-maestro-agent-role={agentRole}
          data-maestro-agent-function={normalizedFunction}
          data-maestro-selected={selected ? 'true' : undefined}
          data-maestro-renaming={renaming ? 'true' : undefined}
          data-maestro-terminal-pane-key={
            surface.binding.kind === 'terminal' ? maestroTerminalSurfacePaneKey(surface) : undefined
          }
          aria-busy={visiblePresencePhase === 'entering'}
          tabIndex={0}
          onFocus={(event) => {
            if (event.target === event.currentTarget) {
              selectWithoutTerminalFocus()
            }
          }}
          onPointerDown={(event) => {
            if (event.target === event.currentTarget) {
              selectWithoutTerminalFocus()
            }
          }}
        >
          <div
            className="flex min-w-0 flex-1 flex-col overflow-hidden rounded-[inherit]"
            data-maestro-window-content=""
          >
            <header
              className="flex h-12 shrink-0 cursor-move items-center gap-2 border-b border-border/80 bg-muted/35 px-2.5"
              onPointerDown={(event) => {
                selectWithoutTerminalFocus()
                startMaestroWorkspaceWindowGesture(
                  event,
                  worldZoom,
                  placement,
                  'move',
                  onMoveCommit
                )
              }}
            >
              <span className="flex size-5 shrink-0 items-center justify-center rounded-md border border-border/70 bg-background/70">
                <Icon className="size-3 text-muted-foreground" />
              </span>
              <span className="flex min-w-0 flex-1 flex-col justify-center">
                {renaming ? (
                  <MaestroWorkspaceInlineTitle
                    title={visibleTitle}
                    onCommit={(title) => {
                      setRenaming(false)
                      onRename(title)
                    }}
                    onCancel={() => setRenaming(false)}
                  />
                ) : (
                  <span className="truncate text-[15px] font-semibold leading-5">
                    {visibleTitle}
                  </span>
                )}
                {roleLabel || functionLabel ? (
                  <span className="flex min-w-0 items-center gap-1.5 truncate text-[10px] font-medium leading-3.5 text-muted-foreground">
                    <Workflow className="size-3 shrink-0" />
                    {roleLabel ? (
                      <span className="shrink-0 font-semibold uppercase tracking-[0.07em] text-foreground/85">
                        {roleLabel}
                      </span>
                    ) : null}
                    {roleLabel && functionLabel ? <span aria-hidden>·</span> : null}
                    {functionLabel ? <span className="truncate">{functionLabel}</span> : null}
                  </span>
                ) : null}
              </span>
              {surface.availability !== 'available' ? (
                <span className="text-[10px] font-medium text-muted-foreground">
                  {surface.availability}
                </span>
              ) : null}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      selectWithoutTerminalFocus()
                      setRenaming(true)
                    }}
                  >
                    <TextCursorInput />
                    <span className="sr-only">
                      {translate(
                        'auto.components.maestro.MaestroWorkspaceWindow.97d6f5fe39',
                        'Rename tab'
                      )}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {translate(
                    'auto.components.maestro.MaestroWorkspaceWindow.97d6f5fe39',
                    'Rename tab'
                  )}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      onFocus()
                    }}
                    disabled={pending}
                  >
                    <Focus />
                    <span className="sr-only">
                      {translate(
                        'auto.components.maestro.MaestroWorkspaceWindow.e825702fbf',
                        'Focus exact tab'
                      )}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {translate(
                    'auto.components.maestro.MaestroWorkspaceWindow.e825702fbf',
                    'Focus exact tab'
                  )}
                </TooltipContent>
              </Tooltip>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    onPointerDown={(event) => event.stopPropagation()}
                    onClick={(event) => {
                      event.stopPropagation()
                      requestClose()
                    }}
                    disabled={pending}
                  >
                    <X />
                    <span className="sr-only">
                      {translate(
                        'auto.components.maestro.MaestroWorkspaceWindow.7f9b469dba',
                        'Close exact tab'
                      )}
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent>
                  {translate(
                    'auto.components.maestro.MaestroWorkspaceWindow.7f9b469dba',
                    'Close exact tab'
                  )}
                </TooltipContent>
              </Tooltip>
            </header>
            <div className="min-h-0 flex-1">
              <MaestroWorkspaceSurfacePreview
                surface={surface}
                runtimeTarget={runtimeTarget}
                previewMode={previewMode}
                selected={selected}
                focusTerminalOnMount={selected && focusTerminalOnMount}
                onRequestTerminalInput={() => {
                  setFocusTerminalOnMount(true)
                  if (!selected) {
                    onSelect()
                  }
                }}
                agentFunctionLabel={normalizedFunction}
                agentRole={agentRole}
                onUpdateAnnotationContent={onUpdateAnnotationContent}
              />
            </div>
          </div>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="group absolute -right-2 top-1/2 z-10 flex size-5 -translate-y-1/2 cursor-crosshair items-center justify-center rounded-full border border-border bg-card text-muted-foreground shadow-xs outline-none transition hover:scale-110 hover:border-ring hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
                aria-label={translate(
                  'auto.components.maestro.MaestroWorkspaceWindow.39b239dd72',
                  'Drag a link from {{value0}}',
                  { value0: visibleTitle }
                )}
                onPointerDown={onLinkPointerDown}
                onClick={(event) => event.preventDefault()}
              >
                <Link2 className="size-2.5" />
              </button>
            </TooltipTrigger>
            <TooltipContent>
              {translate(
                'auto.components.maestro.MaestroWorkspaceWindow.c8d0b36e56',
                'Drag to another window to link'
              )}
            </TooltipContent>
          </Tooltip>
          <button
            type="button"
            className="absolute bottom-1 right-1 z-10 size-5 cursor-se-resize rounded-md border border-border/80 bg-card/90 text-muted-foreground shadow-xs outline-none transition hover:border-ring hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring after:absolute after:bottom-[4px] after:right-[4px] after:size-2 after:border-b-2 after:border-r-2 after:border-current"
            aria-label={translate(
              'auto.components.maestro.MaestroWorkspaceWindow.14b6f795aa',
              'Resize {{value0}}',
              { value0: visibleTitle }
            )}
            onPointerDown={(event) => {
              selectWithoutTerminalFocus()
              startMaestroWorkspaceWindowGesture(
                event,
                worldZoom,
                placement,
                'resize',
                onResizeCommit
              )
            }}
          />
          <div
            className="pointer-events-none absolute inset-0 z-20 origin-top-left rounded-xl border border-ring bg-ring/[0.08] opacity-0 shadow-sm will-change-transform"
            data-maestro-workspace-gesture-preview
            aria-hidden
          />
        </article>
      </ContextMenuTrigger>
      <ContextMenuContent className="w-48">
        <ContextMenuItem onSelect={() => setRenaming(true)}>
          <TextCursorInput />
          {translate('auto.components.maestro.MaestroWorkspaceWindow.rename', 'Rename tab')}
        </ContextMenuItem>
        <ContextMenuItem disabled={pending} onSelect={onFocus}>
          <Focus />
          {translate(
            'auto.components.maestro.MaestroWorkspaceWindow.e825702fbf',
            'Focus exact tab'
          )}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem variant="destructive" disabled={pending} onSelect={requestClose}>
          <X />
          {translate(
            'auto.components.maestro.MaestroWorkspaceWindow.7f9b469dba',
            'Close exact tab'
          )}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  )
}
