import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Copy, FileCode2, Pencil, Play, Trash2 } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { isImeOwnedKeyboardEvent } from '@/lib/text-input/ime/ime-composition-keyboard-event'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useActiveRepo } from '@/store/repos/use-repository-catalog'
import { useConfirmationDialog } from '@/components/dismiss/confirmation/confirmation-dialog-context'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import {
  WORKFLOW_PRESETS,
  resolvePresetDescription,
  resolvePresetLabel,
  useWorkflowSelectionStore,
  type WorkflowPreset
} from '../../workbench/workflow-presets'
import { loadRepoYamlWorkflows, serializeWorkflowYaml } from '../../workbench/workflow-yaml'

function SidebarWorkflowItem({
  preset,
  label,
  active,
  onSelect,
  onEditYaml,
  onSaveAsYaml,
  onRename,
  onDuplicate,
  onDelete
}: {
  preset: WorkflowPreset
  label: string
  active: boolean
  onSelect: () => void
  onEditYaml: () => void
  onSaveAsYaml: () => void
  onRename: (nextName: string) => Promise<void>
  onDuplicate: () => void
  onDelete: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const [renaming, setRenaming] = useState(false)
  const [draftName, setDraftName] = useState(label)
  const inputRef = useRef<HTMLInputElement>(null)
  const pendingRenameFocusRef = useRef(false)

  const startRename = (): void => {
    pendingRenameFocusRef.current = true
    setDraftName(label)
    setRenaming(true)
  }

  const commitRename = async (): Promise<void> => {
    const trimmed = draftName.trim()
    setRenaming(false)
    if (trimmed && trimmed !== label) {
      await onRename(trimmed)
    }
  }

  useEffect(() => {
    if (!renaming) {
      return
    }
    const raf = window.requestAnimationFrame(() => {
      inputRef.current?.focus()
      inputRef.current?.select()
    })
    return () => window.cancelAnimationFrame(raf)
  }, [renaming])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        {renaming ? (
          <div className="flex w-full items-center gap-1.5 rounded-md bg-worktree-sidebar-accent/70 px-2 py-0.5">
            <FileCode2 className="size-3 shrink-0 opacity-70" />
            <input
              ref={inputRef}
              type="text"
              value={draftName}
              onChange={(e) => setDraftName(e.target.value)}
              onBlur={() => void commitRename()}
              onKeyDown={(e) => {
                if (isImeOwnedKeyboardEvent(e)) {
                  return
                }
                if (e.key === 'Enter') {
                  e.preventDefault()
                  void commitRename()
                } else if (e.key === 'Escape') {
                  e.preventDefault()
                  setRenaming(false)
                }
              }}
              className="w-full min-w-0 bg-transparent text-[12px] text-worktree-sidebar-foreground outline-none"
            />
          </div>
        ) : (
          <button
            type="button"
            onClick={onSelect}
            className={cn(
              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors',
              active
                ? 'bg-worktree-sidebar-accent font-medium text-worktree-sidebar-accent-foreground'
                : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
            )}
          >
            {preset.filePath ? (
              <FileCode2 className="size-3 shrink-0 opacity-70" />
            ) : (
              <Play className="size-2.5 shrink-0 opacity-60" />
            )}
            <span className="truncate">{label}</span>
          </button>
        )}
      </ContextMenuTrigger>

      <ContextMenuContent
        onCloseAutoFocus={(e) => {
          if (pendingRenameFocusRef.current) {
            pendingRenameFocusRef.current = false
            e.preventDefault()
          }
        }}
      >
        {preset.filePath ? (
          <>
            <ContextMenuItem onSelect={onEditYaml}>
              <FileCode2 className="size-3.5" />
              {t('workbench.workflowMenu.editYaml', '编辑 YAML')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={startRename}>
              <Pencil className="size-3.5" />
              {t('workbench.workflowMenu.rename', '重命名')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onDuplicate}>
              <Copy className="size-3.5" />
              {t('workbench.workflowMenu.duplicate', '创建副本')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-3.5" />
              {t('workbench.workflowMenu.delete', '删除')}
            </ContextMenuItem>
          </>
        ) : (
          <>
            <ContextMenuItem onSelect={onSelect}>
              <Play className="size-3.5" />
              {t('workbench.workflowMenu.open', '打开工作流')}
            </ContextMenuItem>
            <ContextMenuItem onSelect={onSaveAsYaml}>
              <FileCode2 className="size-3.5" />
              {t('workbench.workflowMenu.saveAsYaml', '另存为 YAML 编辑')}
            </ContextMenuItem>
            <ContextMenuSeparator />
            <ContextMenuItem variant="destructive" onSelect={onDelete}>
              <Trash2 className="size-3.5" />
              {t('workbench.workflowMenu.delete', '删除')}
            </ContextMenuItem>
          </>
        )}
      </ContextMenuContent>
    </ContextMenu>
  )
}

export function SidebarWorkflowList(): React.JSX.Element {
  const t = useTranslate()
  const confirm = useConfirmationDialog()
  const activeView = useAppStore((s) => s.activeView)
  const openWorkbenchPage = useAppStore((s) => s.openWorkbenchPage)
  const activeWorktreeId = useAppStore((s) => s.activeWorktreeId)
  const activeWorktree = useAppStore((s) =>
    activeWorktreeId ? (s.getKnownWorktreeById(activeWorktreeId) ?? null) : null
  )
  const repo = useActiveRepo()
  const targetDir = useWorkflowSelectionStore((s) => s.targetDir)
  const rootPath = targetDir ?? activeWorktree?.path ?? repo?.path ?? null
  const connectionId =
    targetDir && targetDir !== repo?.path ? undefined : (repo?.connectionId ?? undefined)

  const selectedWorkflowId = useWorkflowSelectionStore((s) => s.selectedWorkflowId)
  const setSelectedWorkflowId = useWorkflowSelectionStore((s) => s.setSelectedWorkflowId)
  const hiddenPresetIds = useWorkflowSelectionStore((s) => s.hiddenPresetIds)
  const hidePreset = useWorkflowSelectionStore((s) => s.hidePreset)
  const triggerWorkflowRefresh = useWorkflowSelectionStore((s) => s.triggerWorkflowRefresh)
  const refreshToken = useWorkflowSelectionStore((s) => s.refreshToken)
  const [yamlWorkflows, setYamlWorkflows] = useState<WorkflowPreset[]>([])

  useEffect(() => {
    if (!rootPath) {
      setYamlWorkflows([])
      return
    }
    let cancelled = false
    void loadRepoYamlWorkflows(rootPath, connectionId).then((loaded) => {
      if (!cancelled) {
        setYamlWorkflows(loaded)
        if (
          loaded.length > 0 &&
          useWorkflowSelectionStore.getState().selectedWorkflowId === 'dev-e2e'
        ) {
          setSelectedWorkflowId(loaded[0].id)
        }
      }
    })
    return () => {
      cancelled = true
    }
  }, [connectionId, refreshToken, rootPath, setSelectedWorkflowId])

  const openYamlInEditor = useCallback(
    (filePath: string) => {
      if (!rootPath) {
        return
      }
      const relativePath = filePath.slice(rootPath.length).replace(/^[\\/]+/, '')
      const state = useAppStore.getState()
      state.openFile({
        filePath,
        relativePath,
        worktreeId: activeWorktreeId ?? '',
        language: 'yaml',
        mode: 'edit'
      })
      state.setActiveView('terminal')
    },
    [activeWorktreeId, rootPath]
  )

  const handleRename = useCallback(
    async (preset: WorkflowPreset, nextName: string) => {
      if (!preset.filePath) {
        return
      }
      const content = serializeWorkflowYaml(
        nextName,
        resolvePresetDescription(preset, t),
        preset.nodes
      )
      await window.api.fs.writeFile({ filePath: preset.filePath, content, connectionId })
      triggerWorkflowRefresh()
    },
    [connectionId, t, triggerWorkflowRefresh]
  )

  const handleDuplicateOrSaveAsYaml = useCallback(
    async (preset: WorkflowPreset, isDuplicate: boolean) => {
      if (!rootPath) {
        return
      }
      const baseLabel = resolvePresetLabel(preset, t)
      const nextName = isDuplicate ? `${baseLabel} (Copy)` : baseLabel
      const slug = isDuplicate
        ? `workflow-${Date.now().toString().slice(-4)}`
        : `${preset.id}-${Date.now().toString().slice(-4)}`
      const fileName = `${slug}.yml`
      const filePath = `${rootPath.replace(/[\\/]+$/, '')}/.orca/workflows/${fileName}`
      const content = serializeWorkflowYaml(
        nextName,
        resolvePresetDescription(preset, t),
        preset.nodes
      )
      await window.api.fs.writeFile({ filePath, content, connectionId })
      setSelectedWorkflowId(`yaml:${fileName}`)
      triggerWorkflowRefresh()
      if (!isDuplicate) {
        openYamlInEditor(filePath)
      }
    },
    [connectionId, openYamlInEditor, rootPath, setSelectedWorkflowId, t, triggerWorkflowRefresh]
  )

  const visiblePresets = useMemo(
    () => WORKFLOW_PRESETS.filter((p) => !hiddenPresetIds.includes(p.id)),
    [hiddenPresetIds]
  )

  const items = useMemo(
    () => (yamlWorkflows.length > 0 ? [...yamlWorkflows, ...visiblePresets] : visiblePresets),
    [visiblePresets, yamlWorkflows]
  )

  const handleDelete = useCallback(
    async (preset: WorkflowPreset) => {
      const label = resolvePresetLabel(preset, t)
      const confirmed = await confirm({
        title: t('workbench.workflowMenu.deleteTitle', '删除工作流'),
        description: preset.filePath
          ? t(
              'workbench.workflowMenu.deleteYamlDescription',
              '确定要删除工作流「{{name}}」吗？这将从 .orca/workflows 中移除对应的 YAML 文件。',
              { name: label }
            )
          : t(
              'workbench.workflowMenu.deletePresetDescription',
              '确定要从列表中移除预设工作流「{{name}}」吗？',
              { name: label }
            ),
        confirmLabel: t('workbench.workflowMenu.deleteConfirm', '删除'),
        cancelLabel: t('workbench.workflowMenu.deleteCancel', '取消'),
        confirmVariant: 'destructive'
      })
      if (!confirmed) {
        return
      }
      if (preset.filePath) {
        await window.api.fs.deletePath({ targetPath: preset.filePath, connectionId })
        triggerWorkflowRefresh()
      } else {
        hidePreset(preset.id)
      }
      if (useWorkflowSelectionStore.getState().selectedWorkflowId === preset.id) {
        const nextPreset = items.find((w) => w.id !== preset.id)
        setSelectedWorkflowId(nextPreset?.id ?? WORKFLOW_PRESETS[0].id)
      }
    },
    [confirm, connectionId, hidePreset, items, setSelectedWorkflowId, t, triggerWorkflowRefresh]
  )

  return (
    <div className="ml-4 flex flex-col gap-0.5 border-l border-worktree-sidebar-border/60 pl-2">
      {items.map((preset) => {
        const active = activeView === 'workbench' && selectedWorkflowId === preset.id
        const label = resolvePresetLabel(preset, t)
        return (
          <SidebarWorkflowItem
            key={preset.id}
            preset={preset}
            label={label}
            active={active}
            onSelect={() => {
              setSelectedWorkflowId(preset.id)
              openWorkbenchPage()
            }}
            onEditYaml={() => {
              if (preset.filePath) {
                openYamlInEditor(preset.filePath)
              }
            }}
            onSaveAsYaml={() => void handleDuplicateOrSaveAsYaml(preset, false)}
            onRename={(nextName) => handleRename(preset, nextName)}
            onDuplicate={() => void handleDuplicateOrSaveAsYaml(preset, true)}
            onDelete={() => void handleDelete(preset)}
          />
        )
      })}
    </div>
  )
}
