import { TerminalSquare } from 'lucide-react'
import type { WorkspaceSurface } from '../../../../shared/maestro-workspace-canvas'
import { AgentTerminalPreview } from '@/components/dashboard-popout/AgentTerminalPreview'
import { RecoverableRenderErrorBoundary } from '@/components/error-boundaries/RecoverableRenderErrorBoundary'
import { translate } from '@/i18n/i18n'
import type { RuntimeClientTarget } from '@/runtime/runtime-client-target'
import { MaestroWorkspaceBrowserPreview } from './MaestroWorkspaceBrowserPreview'
import { MaestroWorkspaceContentPreview } from './MaestroWorkspaceContentPreview'
import type { MaestroWorkspacePreviewMode } from './maestro-workspace-visibility'

type MaestroWorkspaceSurfacePreviewProps = {
  surface: WorkspaceSurface
  runtimeTarget: RuntimeClientTarget
  previewMode: MaestroWorkspacePreviewMode
  selected: boolean
  focusTerminalOnMount: boolean
  onRequestTerminalInput: () => void
  agentFunctionLabel?: string
  agentRole?: 'coordinator' | 'worker'
  onUpdateAnnotationContent?: (content: string) => void
}

function LowDetailSurfacePreview({
  surface,
  previewMode,
  agentFunctionLabel,
  agentRole
}: Pick<
  MaestroWorkspaceSurfacePreviewProps,
  'surface' | 'previewMode' | 'agentFunctionLabel' | 'agentRole'
>): React.JSX.Element {
  const detail =
    previewMode === 'identity'
      ? translate(
          'auto.components.maestro.MaestroWorkspaceWindow.previewIdentity',
          'Live preview hidden at this zoom'
        )
      : translate(
          'auto.components.maestro.MaestroWorkspaceWindow.previewSuspended',
          'Preview paused outside the viewport'
        )
  return (
    <div
      className="flex size-full flex-col items-center justify-center bg-muted/20 p-4 text-center"
      data-maestro-preview-placeholder={previewMode}
    >
      <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
        {surface.content_type}
      </span>
      {agentRole ? (
        <p className="mt-2 max-w-[28ch] truncate text-lg font-semibold text-foreground">
          {agentRole === 'coordinator'
            ? translate(
                'auto.components.maestro.MaestroWorkspaceWindow.coordinator',
                'Orchestrator'
              )
            : (agentFunctionLabel ??
              translate('auto.components.maestro.MaestroWorkspaceWindow.worker', 'Worker'))}
        </p>
      ) : null}
      <p className="mt-1 max-w-[28ch] truncate text-sm font-medium text-foreground">
        {surface.title}
      </p>
      <p className="mt-1 text-[11px] text-muted-foreground">{detail}</p>
      {surface.binding.kind === 'terminal' ? (
        <span className="mt-2 text-[10px] text-muted-foreground">{surface.binding.liveness}</span>
      ) : null}
    </div>
  )
}

export function MaestroWorkspaceSurfacePreview({
  surface,
  runtimeTarget,
  previewMode,
  selected,
  focusTerminalOnMount,
  onRequestTerminalInput,
  agentFunctionLabel,
  agentRole,
  onUpdateAnnotationContent
}: MaestroWorkspaceSurfacePreviewProps): React.JSX.Element {
  if (previewMode === 'suspended') {
    return (
      <LowDetailSurfacePreview
        surface={surface}
        previewMode={previewMode}
        agentFunctionLabel={agentFunctionLabel}
        agentRole={agentRole}
      />
    )
  }
  const binding = surface.binding
  if (binding.kind === 'terminal') {
    if (binding.session_id && binding.liveness === 'live') {
      return (
        <div
          className="size-full"
          data-maestro-terminal-input-surface=""
          onPointerDown={() => onRequestTerminalInput()}
        >
          <RecoverableRenderErrorBoundary
            boundaryId={`maestro-workspace-terminal-${binding.session_id}`}
            surface="overlay"
            resetKey={`${binding.session_id}:${binding.pty_incarnation ?? 'unknown'}`}
            title={translate(
              'auto.components.maestro.MaestroWorkspaceWindow.52cce7f247',
              'Terminal output could not attach.'
            )}
            description={translate(
              'auto.components.maestro.MaestroWorkspaceWindow.c6b6befac1',
              'The exact terminal remains available in its own tab.'
            )}
          >
            <AgentTerminalPreview
              ptyId={binding.session_id}
              autoFocus={focusTerminalOnMount}
              mode="canvas"
              inputEnabled={selected}
              liveRefreshIntervalMs={previewMode === 'identity' ? 420 : selected ? 64 : 240}
              className="size-full"
            />
          </RecoverableRenderErrorBoundary>
        </div>
      )
    }
    return (
      <div className="flex h-full flex-col items-center justify-center bg-[var(--terminal-pane-surface-on-dark)] p-3 text-center text-xs text-[var(--terminal-pane-title-on-dark-fg)]">
        <TerminalSquare className="size-5" />
        <p className="mt-2">
          {binding.liveness === 'live'
            ? translate(
                'auto.components.maestro.MaestroWorkspaceWindow.1ac69faf69',
                'The live terminal preview is reconnecting.'
              )
            : translate(
                'auto.components.maestro.MaestroWorkspaceWindow.37f9e2104d',
                'Terminal output is {{value0}}.',
                { value0: binding.liveness }
              )}
        </p>
      </div>
    )
  }
  if (binding.kind === 'browser') {
    const receiptRevision =
      binding.live_frame?.frame_revision ??
      binding.immutable_capture?.page_revision ??
      binding.authority_revision
    return (
      <MaestroWorkspaceBrowserPreview
        target={runtimeTarget}
        pageId={binding.browser_page_id}
        browserWorkspaceId={binding.browser_workspace_id}
        receiptRevision={receiptRevision}
        selected={selected}
        previewMode={previewMode}
        onInteract={onRequestTerminalInput}
      />
    )
  }
  return (
    <MaestroWorkspaceContentPreview
      target={runtimeTarget}
      surface={surface}
      onUpdateAnnotationContent={onUpdateAnnotationContent}
    />
  )
}
