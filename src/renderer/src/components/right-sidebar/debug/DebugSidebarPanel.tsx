import { useEffect, useState } from 'react'
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  Ban,
  CircleDot,
  CornerDownRight,
  Pause,
  Play,
  Plug,
  SkipForward,
  Square
} from 'lucide-react'
import { Button } from '../../ui/button'
import {
  DebugAdaptersSection,
  DebugMissingAdapterBanner
} from '../../editor/debug/DebugAdaptersSection'
import { DebugAttachProcessDialog } from '../../editor/debug/DebugAttachProcessDialog'
import { DebugBreakpointsDialog } from '../../editor/debug/DebugBreakpointsDialog'
import { DebugSessionPanel } from '../../editor/debug/DebugSessionPanel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { useAppStore } from '@/store/index'
import {
  inferAdapterForFile,
  navigateToSourceLocation,
  resolveWorkspaceRoot,
  useDebugSessionStore
} from '@/store/debug/use-debug-session-store'

export default function DebugSidebarPanel(): React.JSX.Element {
  const t = useTranslate()
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeFileId = useAppStore((s) => s.activeFileId)
  const openFiles = useAppStore((s) => s.openFiles)
  const activeFile = openFiles.find((f) => f.id === activeFileId) ?? null
  const workspaceRoot = resolveWorkspaceRoot(
    activeWorktreeId,
    activeFile?.filePath,
    activeFile?.relativePath
  )

  const [selectedConfigId, setSelectedConfigId] = useState<string>('')
  const [attachOpen, setAttachOpen] = useState(false)
  const [breakpointsOpen, setBreakpointsOpen] = useState(false)

  const sessionsById = useDebugSessionStore((s) => s.sessionsById)
  const activeSessionId = useDebugSessionStore((s) => s.activeSessionId)
  const status = useDebugSessionStore((s) => s.status)
  const capabilities = useDebugSessionStore((s) => s.capabilities)
  const discoveredConfigs = useDebugSessionStore((s) => s.discoveredConfigs)
  const breakpointsByFile = useDebugSessionStore((s) => s.breakpointsByFile)
  const breakpointPathsByKey = useDebugSessionStore((s) => s.breakpointPathsByKey)
  const breakpointsMuted = useDebugSessionStore((s) => s.breakpointsMuted)
  const smartStep = useDebugSessionStore((s) => s.smartStep)
  const lastError = useDebugSessionStore((s) => s.lastError)

  const startSession = useDebugSessionStore((s) => s.startSession)
  const stopSession = useDebugSessionStore((s) => s.stopSession)
  const selectSession = useDebugSessionStore((s) => s.selectSession)
  const resume = useDebugSessionStore((s) => s.resume)
  const pause = useDebugSessionStore((s) => s.pause)
  const stepOver = useDebugSessionStore((s) => s.stepOver)
  const stepInto = useDebugSessionStore((s) => s.stepInto)
  const stepOut = useDebugSessionStore((s) => s.stepOut)
  const startSmartStepInto = useDebugSessionStore((s) => s.startSmartStepInto)
  const chooseSmartStepTarget = useDebugSessionStore((s) => s.chooseSmartStepTarget)
  const cancelSmartStep = useDebugSessionStore((s) => s.cancelSmartStep)
  const setBreakpointsMuted = useDebugSessionStore((s) => s.setBreakpointsMuted)
  const updateBreakpoint = useDebugSessionStore((s) => s.updateBreakpoint)
  const refreshDiscoveredConfigs = useDebugSessionStore((s) => s.refreshDiscoveredConfigs)

  useEffect(() => {
    void refreshDiscoveredConfigs(workspaceRoot, activeFile?.filePath ?? null)
  }, [activeFile?.filePath, refreshDiscoveredConfigs, workspaceRoot])

  const isActive = status === 'starting' || status === 'running' || status === 'stopped'
  const isStopped = status === 'stopped'
  const sessionsList = Object.values(sessionsById)
  const chosenPreset =
    discoveredConfigs.find((c) => c.id === selectedConfigId) ?? discoveredConfigs[0] ?? null

  const smartStepChoices = smartStep && !smartStep.inline ? smartStep.targets : null
  const lineEntries = Object.entries(breakpointsByFile).flatMap(([fileKey, bps]) => {
    const filePath = breakpointPathsByKey[fileKey] ?? fileKey
    const fileName = filePath.split(/[\\/]/).at(-1) || filePath
    return bps.map((bp) => ({ fileKey, filePath, fileName, bp }))
  })

  const handleLaunch = (): void => {
    if (chosenPreset) {
      void startSession({
        name: chosenPreset.name,
        adapter: chosenPreset.adapter,
        request: chosenPreset.request,
        program: chosenPreset.program,
        args: chosenPreset.args,
        cwd: chosenPreset.cwd || workspaceRoot || undefined,
        env: chosenPreset.env,
        extraJson: chosenPreset.extraJson
      })
      return
    }
    if (!activeFile) {
      return
    }
    void startSession({
      name: activeFile.relativePath || activeFile.filePath,
      adapter: inferAdapterForFile(activeFile.filePath),
      request: 'launch',
      program: activeFile.filePath,
      args: [],
      cwd: workspaceRoot || undefined,
      env: {}
    })
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col text-xs">
      <div className="space-y-2 border-b border-border px-3 py-2.5">
        <div className="flex items-center gap-1.5">
          {discoveredConfigs.length > 0 ? (
            <select
              aria-label={t('auto.components.editor.debug.launchPresetLabel', 'Launch Config')}
              disabled={isActive}
              value={chosenPreset?.id ?? ''}
              onChange={(e) => setSelectedConfigId(e.target.value)}
              className="h-7 min-w-0 flex-1 rounded border border-border/70 bg-background px-2 text-xs text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              {discoveredConfigs.map((cfg) => (
                <option key={cfg.id} value={cfg.id}>
                  [{cfg.source}] {cfg.name}
                </option>
              ))}
            </select>
          ) : (
            <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground">
              {activeFile?.relativePath ?? workspaceRoot ?? '—'}
            </span>
          )}

          {!isActive ? (
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={!chosenPreset && !activeFile}
              onClick={handleLaunch}
            >
              <Play className="size-3 text-status-success" />
              {chosenPreset
                ? t('auto.components.editor.debug.debugAction', 'Debug')
                : t('auto.components.editor.debug.debugFileAction', 'Debug File')}
            </Button>
          ) : (
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t('auto.components.editor.debug.stopTitle', 'Stop Debug')}
              onClick={() => void stopSession()}
            >
              <Square className="size-3 fill-destructive text-destructive" />
            </Button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-1.5">
          <div className="flex items-center gap-1">
            {isActive ? (
              <>
                {sessionsList.length > 1 ? (
                  <select
                    aria-label={t('auto.components.editor.debug.sessionSelect', 'Debug Session')}
                    value={activeSessionId ?? ''}
                    onChange={(e) => void selectSession(Number(e.target.value))}
                    className="h-6 max-w-28 rounded border border-border/70 bg-background px-1 text-[10px] text-foreground outline-none"
                  >
                    {sessionsList.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.parent ? `↳ ${s.name}` : s.name}
                      </option>
                    ))}
                  </select>
                ) : null}
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  title={
                    isStopped
                      ? t('auto.components.editor.debug.continueTitle', 'Continue')
                      : t('auto.components.editor.debug.pauseTitle', 'Pause')
                  }
                  onClick={() => void (isStopped ? resume() : pause())}
                >
                  {isStopped ? (
                    <Play className="size-3 text-status-success" />
                  ) : (
                    <Pause className="size-3 text-status-warning" />
                  )}
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!isStopped}
                  title={t('auto.components.editor.debug.stepOverTitle', 'Step Over')}
                  onClick={() => void stepOver()}
                >
                  <SkipForward className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!isStopped}
                  title={t('auto.components.editor.debug.stepIntoTitle', 'Step Into')}
                  onClick={() => void stepInto()}
                >
                  <ArrowDownToLine className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!isStopped || !capabilities?.stepInTargets}
                  title={t('auto.components.editor.debug.smartStepIntoTitle', 'Smart Step Into')}
                  onClick={() => void startSmartStepInto(null)}
                >
                  <CornerDownRight className="size-3" />
                </Button>
                <Button
                  type="button"
                  size="icon-xs"
                  variant="ghost"
                  disabled={!isStopped}
                  title={t('auto.components.editor.debug.stepOutTitle', 'Step Out')}
                  onClick={() => void stepOut()}
                >
                  <ArrowUpFromLine className="size-3" />
                </Button>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={() => setAttachOpen(true)}>
              <Plug className="size-3" />
              {t('auto.components.editor.debug.attachAction', 'Attach')}
            </Button>
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => setBreakpointsOpen(true)}
            >
              <CircleDot className="size-3" />
              {t('auto.components.editor.debug.breakpointsTitle', 'Breakpoints')}
            </Button>
          </div>
        </div>

        {lastError ? (
          <div className="truncate text-[11px] text-destructive" title={lastError}>
            {lastError}
          </div>
        ) : null}
      </div>

      <DebugMissingAdapterBanner />

      {smartStepChoices ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-border/60 px-3 py-1.5">
          <span className="text-[11px] text-muted-foreground">
            {t('auto.components.editor.debug.smartStepPrompt', 'Step into:')}
          </span>
          {smartStepChoices.map((target) => (
            <Button
              key={target.id}
              type="button"
              size="xs"
              variant="outline"
              onClick={() => void chooseSmartStepTarget(target.id)}
            >
              {target.label}
            </Button>
          ))}
          <Button type="button" size="xs" variant="ghost" onClick={cancelSmartStep}>
            {t('auto.components.editor.debug.cancelAction', 'Cancel')}
          </Button>
        </div>
      ) : null}

      <div className="flex-1 space-y-3 overflow-y-auto scrollbar-sleek p-2.5">
        <div className="overflow-hidden rounded border border-border/70">
          <DebugSessionPanel layout="vertical" />
        </div>

        <div className="space-y-1.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-[11px] font-medium text-muted-foreground">
              {t('auto.components.editor.debug.breakpointsSectionTitle', 'Breakpoints')} (
              {lineEntries.length})
            </span>
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              aria-pressed={breakpointsMuted}
              title={
                breakpointsMuted
                  ? t('auto.components.editor.debug.unmuteBreakpointsTitle', 'Unmute Breakpoints')
                  : t('auto.components.editor.debug.muteBreakpointsTitle', 'Mute Breakpoints')
              }
              onClick={() => void setBreakpointsMuted(!breakpointsMuted)}
            >
              <Ban
                className={cn(
                  'size-3',
                  breakpointsMuted ? 'text-status-warning' : 'text-muted-foreground'
                )}
              />
            </Button>
          </div>
          {lineEntries.length > 0 ? (
            <div className="divide-y divide-border/50 rounded border border-border/70 bg-background/50">
              {lineEntries.map((entry) => (
                <div
                  key={`${entry.fileKey}:${entry.bp.line}`}
                  className="flex items-center gap-2 px-2 py-1 font-mono text-[11px] hover:bg-accent/50"
                >
                  <input
                    type="checkbox"
                    checked={entry.bp.enabled}
                    onChange={(e) =>
                      void updateBreakpoint(entry.filePath, entry.bp.line, {
                        enabled: e.target.checked
                      })
                    }
                    className="size-3 shrink-0"
                  />
                  <button
                    type="button"
                    onClick={() => navigateToSourceLocation(entry.filePath, entry.bp.line, 1)}
                    className="min-w-0 flex-1 truncate text-left text-foreground hover:underline"
                    title={entry.filePath}
                  >
                    {entry.fileName}:{entry.bp.line}
                  </button>
                </div>
              ))}
            </div>
          ) : null}
        </div>

        <DebugAdaptersSection cwd={workspaceRoot} />
      </div>

      <DebugAttachProcessDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        workspaceRoot={workspaceRoot}
      />
      <DebugBreakpointsDialog open={breakpointsOpen} onOpenChange={setBreakpointsOpen} />
    </div>
  )
}
