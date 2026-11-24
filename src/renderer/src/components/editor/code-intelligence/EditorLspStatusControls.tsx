import { useEffect, useRef, useState } from 'react'
import {
  AlertCircle,
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  CheckCircle2,
  Cpu,
  Download,
  ListTree,
  RefreshCw
} from 'lucide-react'
import { useTranslate } from '@/i18n/use-translate'
import { Button } from '../../ui/button'
import { cn } from '@/lib/class-names'
import { useCodeIntelligenceStore } from '@/store/code-intelligence/use-code-intelligence-store'
import {
  normalizeDebugPathKey,
  resolveWorkspaceRootForFile
} from '@/store/debug/debug-session-paths'

const EMPTY_DIAGNOSTICS: never[] = []

export function EditorLspStatusControls({
  filePath,
  relativePath,
  worktreeId,
  language,
  onOpenOutline
}: {
  filePath: string
  relativePath: string
  worktreeId?: string
  language: string
  onOpenOutline: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [serversOpen, setServersOpen] = useState(false)
  const popoverRef = useRef<HTMLDivElement | null>(null)
  const fileKey = normalizeDebugPathKey(filePath)
  const workspaceRoot = resolveWorkspaceRootForFile(filePath, relativePath, worktreeId)

  const canGoBack = useCodeIntelligenceStore((s) => s.canGoBack)
  const canGoForward = useCodeIntelligenceStore((s) => s.canGoForward)
  const navigateBack = useCodeIntelligenceStore((s) => s.navigateBack)
  const navigateForward = useCodeIntelligenceStore((s) => s.navigateForward)
  const diagnostics = useCodeIntelligenceStore(
    (s) => s.diagnosticsByFile[fileKey] ?? EMPTY_DIAGNOSTICS
  )
  const runtimeStatusByServer = useCodeIntelligenceStore((s) => s.runtimeStatusByServer)
  const serverStatuses = useCodeIntelligenceStore((s) => s.serverStatuses)
  const installingServerId = useCodeIntelligenceStore((s) => s.installingServerId)
  const refreshServerStatuses = useCodeIntelligenceStore((s) => s.refreshServerStatuses)
  const installServer = useCodeIntelligenceStore((s) => s.installServer)

  useEffect(() => {
    void refreshServerStatuses(workspaceRoot)
  }, [refreshServerStatuses, workspaceRoot])

  useEffect(() => {
    if (!serversOpen) {
      return
    }
    const onPointerDown = (e: PointerEvent): void => {
      if (e.target instanceof Node && !popoverRef.current?.contains(e.target)) {
        setServersOpen(false)
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true)
    return () => window.removeEventListener('pointerdown', onPointerDown, true)
  }, [serversOpen])

  const errors = diagnostics.filter((d) => d.severity === 'error').length
  const warnings = diagnostics.filter((d) => d.severity === 'warning').length
  const runtimeEntries = Object.values(runtimeStatusByServer)
  const liveReady = runtimeEntries.find((r) => r.status === 'ready')
  const liveStarting = runtimeEntries.find((r) => r.status === 'starting')
  const runningId =
    liveReady?.serverId ?? serverStatuses.find((s) => s.status === 'running')?.id ?? null
  const available = runningId !== null || serverStatuses.some((s) => s.status !== 'missing')
  const busy = installingServerId !== null

  return (
    <div className="relative flex items-center gap-1">
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!canGoBack}
        title={t(
          'auto.components.editor.codeIntelligence.navigateBackTitle',
          'Navigate Back (Alt+Left)'
        )}
        onClick={() => navigateBack()}
      >
        <ArrowLeft className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        disabled={!canGoForward}
        title={t(
          'auto.components.editor.codeIntelligence.navigateForwardTitle',
          'Navigate Forward (Alt+Right)'
        )}
        onClick={() => navigateForward()}
      >
        <ArrowRight className="size-3.5" />
      </Button>
      <Button
        type="button"
        size="icon-xs"
        variant="ghost"
        title={t(
          'auto.components.editor.codeIntelligence.fileStructureOutlineTitle',
          'File Structure / Outline (Ctrl+F12)'
        )}
        onClick={onOpenOutline}
      >
        <ListTree className="size-3.5" />
      </Button>

      {errors > 0 ? (
        <span
          className="flex items-center gap-0.5 text-[11px] text-destructive"
          title={t('auto.components.editor.codeIntelligence.errorsTitle', 'Errors')}
        >
          <AlertCircle className="size-3" />
          {errors}
        </span>
      ) : null}
      {warnings > 0 ? (
        <span
          className="flex items-center gap-0.5 text-[11px] text-status-warning"
          title={t('auto.components.editor.codeIntelligence.warningsTitle', 'Warnings')}
        >
          <AlertTriangle className="size-3" />
          {warnings}
        </span>
      ) : null}

      <Button
        type="button"
        size="xs"
        variant="ghost"
        title={t(
          'auto.components.editor.codeIntelligence.languageIntelligenceTitle',
          'Language Intelligence ({{language}})',
          { language }
        )}
        onClick={() => {
          void refreshServerStatuses(workspaceRoot)
          setServersOpen((o) => !o)
        }}
      >
        <Cpu
          className={cn(
            'size-3',
            runningId
              ? 'text-status-success'
              : liveStarting
                ? 'text-status-warning'
                : available
                  ? 'text-primary'
                  : 'text-muted-foreground'
          )}
        />
        <span className="text-[11px]">
          {runningId ??
            (liveStarting
              ? `${liveStarting.serverId}...`
              : t('auto.components.editor.codeIntelligence.sourceLsp', 'LSP'))}
        </span>
      </Button>

      {serversOpen ? (
        <div
          ref={popoverRef}
          className="fixed right-4 bottom-12 z-50 w-96 max-w-[calc(100vw-24px)] rounded-lg border border-border bg-popover p-2.5 text-popover-foreground shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <span className="text-xs font-semibold">
              {t(
                'auto.components.editor.codeIntelligence.languageServersTitle',
                'Language Servers'
              )}
            </span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t(
                'auto.components.editor.codeIntelligence.refreshStatusTitle',
                'Refresh status'
              )}
              onClick={() => void refreshServerStatuses(workspaceRoot)}
            >
              <RefreshCw className="size-3" />
            </Button>
          </div>
          <div className="divide-y divide-border/50 rounded border border-border/70 bg-background/60">
            {serverStatuses.map((srv) => {
              const isMissing = srv.status === 'missing'
              const installingThis = installingServerId === srv.id
              return (
                <div
                  key={srv.id}
                  className="flex items-center justify-between gap-2 px-2 py-1.5 text-xs"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2
                        className={cn(
                          'size-3 shrink-0',
                          srv.status === 'running' || !isMissing
                            ? 'text-status-success'
                            : 'text-muted-foreground/50'
                        )}
                      />
                      <span className="truncate font-medium">{srv.displayName}</span>
                      <span className="rounded bg-muted px-1 py-0 text-[10px] text-muted-foreground">
                        {srv.status}
                      </span>
                    </div>
                    <div
                      className="mt-0.5 truncate pl-4 font-mono text-[10px] text-muted-foreground"
                      title={srv.path ?? srv.installHint}
                    >
                      {srv.path ?? srv.installHint}
                    </div>
                  </div>
                  {srv.canInstall && isMissing ? (
                    <Button
                      type="button"
                      size="xs"
                      variant="outline"
                      disabled={busy}
                      onClick={() => void installServer(srv.id, workspaceRoot)}
                    >
                      <Download className="size-3" />
                      {installingThis
                        ? t(
                            'auto.components.editor.codeIntelligence.installingAction',
                            'Installing...'
                          )
                        : t('auto.components.editor.codeIntelligence.installAction', 'Install')}
                    </Button>
                  ) : null}
                </div>
              )
            })}
          </div>
        </div>
      ) : null}
    </div>
  )
}
