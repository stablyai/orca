import { useEffect, useState } from 'react'
import { Ban, Bug, ChevronDown, ChevronUp, CircleDot, Play, Plug } from 'lucide-react'
import { Button } from '../../ui/button'
import { EditorLspStatusControls } from '../code-intelligence/EditorLspStatusControls'
import { DebugActiveControls } from './DebugActiveControls'
import { DebugMissingAdapterBanner } from './DebugAdaptersSection'
import { DebugAttachProcessDialog } from './DebugAttachProcessDialog'
import { DebugBreakpointsDialog } from './DebugBreakpointsDialog'
import { DebugLaunchConfigPopover } from './DebugLaunchConfigPopover'
import { DebugSessionPanel } from './DebugSessionPanel'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import {
  inferAdapterForFile,
  normalizeDebugPathKey,
  resolveWorkspaceRootForFile,
  useDebugSessionStore,
  type DebugAdapterId
} from '@/store/debug/use-debug-session-store'
import type { DebugStepInTarget } from '@/store/debug/debug-session-types'

const ADAPTER_IDS: readonly DebugAdapterId[] = [
  'debugpy',
  'js-debug',
  'codelldb',
  'delve',
  'lldb-dap',
  'netcoredbg',
  'rdbg'
]

const MANUAL_OPTION_VALUE = '__manual__'

export function EditorDebugBar({
  filePath,
  relativePath,
  worktreeId,
  language = '',
  onOpenOutline,
  onSmartStepInto
}: {
  filePath: string
  relativePath: string
  worktreeId?: string
  language?: string
  onOpenOutline?: () => void
  onSmartStepInto?: () => void
}): React.JSX.Element {
  const [selectedConfigId, setSelectedConfigId] = useState<string | null>(null)
  const [manualAdapter, setManualAdapter] = useState<DebugAdapterId | null>(null)
  const [requestMode, setRequestMode] = useState<'launch' | 'attach'>('launch')
  const [argsText, setArgsText] = useState('')
  const [cwdOverride, setCwdOverride] = useState('')
  const [extraJson, setExtraJson] = useState('')
  const [attachOpen, setAttachOpen] = useState(false)
  const [breakpointsOpen, setBreakpointsOpen] = useState(false)
  const t = useTranslate()
  // Static keys so extraction sees every adapter label; the tool names stay English.
  const adapterLabels: Record<DebugAdapterId, string> = {
    debugpy: t('auto.components.editor.debug.adapterPython', 'Python (debugpy)'),
    'js-debug': t('auto.components.editor.debug.adapterNode', 'Node / TS (js-debug)'),
    codelldb: t('auto.components.editor.debug.adapterRust', 'Rust / C++ (codelldb)'),
    delve: t('auto.components.editor.debug.adapterGo', 'Go (delve)'),
    'lldb-dap': t('auto.components.editor.debug.adapterLldb', 'LLDB (lldb-dap)'),
    netcoredbg: t('auto.components.editor.debug.adapterDotnet', '.NET (netcoredbg)'),
    rdbg: t('auto.components.editor.debug.adapterRuby', 'Ruby (rdbg)')
  }

  const sessionsById = useDebugSessionStore((s) => s.sessionsById)
  const activeSessionId = useDebugSessionStore((s) => s.activeSessionId)
  const status = useDebugSessionStore((s) => s.status)
  const capabilities = useDebugSessionStore((s) => s.capabilities)
  const smartStep = useDebugSessionStore((s) => s.smartStep)
  const breakpointsMuted = useDebugSessionStore((s) => s.breakpointsMuted)
  const discoveredConfigs = useDebugSessionStore((s) => s.discoveredConfigs)
  const lastError = useDebugSessionStore((s) => s.lastError)
  const panelOpen = useDebugSessionStore((s) => s.panelOpen)
  const bpCount = useDebugSessionStore(
    (s) => s.breakpointsByFile[normalizeDebugPathKey(filePath)]?.length ?? 0
  )

  const setPanelOpen = useDebugSessionStore((s) => s.setPanelOpen)
  const setBreakpointsMuted = useDebugSessionStore((s) => s.setBreakpointsMuted)
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
  const refreshDiscoveredConfigs = useDebugSessionStore((s) => s.refreshDiscoveredConfigs)

  const workspaceRoot = resolveWorkspaceRootForFile(filePath, relativePath, worktreeId)

  useEffect(() => {
    void refreshDiscoveredConfigs(workspaceRoot, filePath)
  }, [filePath, refreshDiscoveredConfigs, workspaceRoot])

  const isActive = status === 'starting' || status === 'running' || status === 'stopped'
  const isStopped = status === 'stopped'
  const sessionsList = Object.values(sessionsById)
  const activeAdapter = manualAdapter ?? inferAdapterForFile(filePath)
  const matchedPreset =
    selectedConfigId === MANUAL_OPTION_VALUE
      ? null
      : (discoveredConfigs.find((c) => c.id === selectedConfigId) ?? discoveredConfigs[0] ?? null)
  const selectorValue = matchedPreset ? matchedPreset.id : MANUAL_OPTION_VALUE

  const handleLaunch = (): void => {
    if (matchedPreset) {
      const parsedExtraArgs = argsText
        .trim()
        .split(/\s+/)
        .filter((part) => part.length > 0)
      void startSession({
        name: matchedPreset.name,
        adapter: matchedPreset.adapter,
        request: matchedPreset.request,
        program: matchedPreset.program,
        args: parsedExtraArgs.length > 0 ? parsedExtraArgs : matchedPreset.args,
        cwd: cwdOverride.trim() || matchedPreset.cwd || workspaceRoot || undefined,
        env: matchedPreset.env,
        extraJson: extraJson.trim() || matchedPreset.extraJson
      })
      return
    }
    const parentDir = filePath.replace(/[\\/][^\\/]+$/, '')
    const parsedArgs = argsText
      .trim()
      .split(/\s+/)
      .filter((part) => part.length > 0)
    void startSession({
      name: relativePath || filePath,
      adapter: activeAdapter,
      request: requestMode,
      program: requestMode === 'launch' ? filePath : undefined,
      args: parsedArgs,
      cwd: cwdOverride.trim() || workspaceRoot || parentDir || undefined,
      env: {},
      extraJson: extraJson.trim() || undefined
    })
  }

  // Step-in targets are debugger-provided (a handful), not an unbounded host list.
  const renderSmartStepTarget = (target: DebugStepInTarget): React.JSX.Element => (
    <Button
      key={target.id}
      type="button"
      size="xs"
      variant="outline"
      onClick={() => void chooseSmartStepTarget(target.id)}
    >
      {target.label}
    </Button>
  )

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-card/80">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 py-1.5 text-xs">
        <div className="flex flex-wrap items-center gap-2">
          <Bug className="size-3.5 text-primary" />

          {discoveredConfigs.length > 0 ? (
            <select
              aria-label={t('auto.components.editor.debug.launchPresetLabel', 'Launch Config')}
              disabled={isActive}
              value={selectorValue}
              onChange={(e) => setSelectedConfigId(e.target.value)}
              className="h-6 max-w-52 rounded border border-border/70 bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              {discoveredConfigs.map((cfg) => (
                <option key={cfg.id} value={cfg.id}>
                  [{cfg.source}] {cfg.name}
                </option>
              ))}
              <option value={MANUAL_OPTION_VALUE}>
                {t('auto.components.editor.debug.manualConfigOption', 'Custom Adapter...')}
              </option>
            </select>
          ) : null}

          {!matchedPreset ? (
            <select
              aria-label={t('auto.components.editor.debug.adapterLabel', 'Debug Adapter')}
              disabled={isActive}
              value={activeAdapter}
              onChange={(e) => {
                const next = ADAPTER_IDS.find((id) => id === e.target.value)
                if (next) {
                  setManualAdapter(next)
                }
              }}
              className="h-6 rounded border border-border/70 bg-background px-1.5 text-[11px] text-foreground outline-none focus:border-primary disabled:opacity-50"
            >
              {ADAPTER_IDS.map((id) => (
                <option key={id} value={id}>
                  {adapterLabels[id]}
                </option>
              ))}
            </select>
          ) : null}

          {!isActive ? (
            <>
              <Button type="button" size="xs" variant="outline" onClick={handleLaunch}>
                <Play className="size-3 text-status-success" />
                {matchedPreset
                  ? matchedPreset.request === 'attach'
                    ? t('auto.components.editor.debug.attachAction', 'Attach')
                    : t('auto.components.editor.debug.debugAction', 'Debug')
                  : requestMode === 'attach'
                    ? t('auto.components.editor.debug.attachAction', 'Attach')
                    : t('auto.components.editor.debug.debugFileAction', 'Debug File')}
              </Button>
              <DebugLaunchConfigPopover
                requestMode={requestMode}
                argsText={argsText}
                cwdOverride={cwdOverride}
                extraJson={extraJson}
                onChangeRequestMode={setRequestMode}
                onChangeArgsText={setArgsText}
                onChangeCwdOverride={setCwdOverride}
                onChangeExtraJson={setExtraJson}
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                title={t('auto.components.editor.debug.attachProcessTitle', 'Attach to Process')}
                onClick={() => setAttachOpen(true)}
              >
                <Plug className="size-3.5" />
              </Button>
            </>
          ) : (
            <DebugActiveControls
              sessionsList={sessionsList}
              activeSessionId={activeSessionId}
              isStopped={isStopped}
              capabilities={capabilities}
              onSelectSession={(id) => void selectSession(id)}
              onResume={() => void resume()}
              onPause={() => void pause()}
              onStepOver={() => void stepOver()}
              onStepInto={() => void stepInto()}
              onSmartStepInto={() => {
                if (onSmartStepInto) {
                  onSmartStepInto()
                } else {
                  void startSmartStepInto(null)
                }
              }}
              onStepOut={() => void stepOut()}
              onStop={() => void stopSession()}
            />
          )}

          <div className="flex items-center gap-1">
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
            <Button
              type="button"
              size="icon-xs"
              variant="ghost"
              title={t('auto.components.editor.debug.viewBreakpointsTitle', 'View Breakpoints')}
              onClick={() => setBreakpointsOpen(true)}
            >
              <CircleDot className="size-3 text-muted-foreground" />
            </Button>
            <span className="font-mono text-[11px] text-muted-foreground">
              {bpCount > 0
                ? t('auto.components.editor.debug.breakpointCount', '{{count}} bp', {
                    count: bpCount
                  })
                : t(
                    'auto.components.editor.debug.breakpointHint',
                    'Click gutter to set breakpoint'
                  )}
            </span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          {lastError ? (
            <span className="max-w-xs truncate text-[11px] text-destructive" title={lastError}>
              {lastError}
            </span>
          ) : null}
          {onOpenOutline ? (
            <EditorLspStatusControls
              filePath={filePath}
              relativePath={relativePath}
              worktreeId={worktreeId}
              language={language}
              onOpenOutline={onOpenOutline}
            />
          ) : null}
          <Button type="button" size="xs" variant="ghost" onClick={() => setPanelOpen(!panelOpen)}>
            {panelOpen ? <ChevronDown className="size-3.5" /> : <ChevronUp className="size-3.5" />}
            {t('auto.components.editor.debug.panelToggle', 'Debug Panel')}
          </Button>
        </div>
      </div>

      <DebugMissingAdapterBanner />

      {smartStep && !smartStep.inline ? (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/60 bg-background/80 px-3 py-1 text-xs">
          <span className="text-[11px] font-medium text-muted-foreground">
            {t('auto.components.editor.debug.smartStepPrompt', 'Step into:')}
          </span>
          {smartStep.targets.map(renderSmartStepTarget)}
          <Button type="button" size="xs" variant="ghost" onClick={cancelSmartStep}>
            {t('auto.components.editor.debug.cancelAction', 'Cancel')}
          </Button>
        </div>
      ) : null}

      {panelOpen ? <DebugSessionPanel /> : null}

      <DebugAttachProcessDialog
        open={attachOpen}
        onOpenChange={setAttachOpen}
        workspaceRoot={workspaceRoot}
      />
      <DebugBreakpointsDialog open={breakpointsOpen} onOpenChange={setBreakpointsOpen} />
    </div>
  )
}
