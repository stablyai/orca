import { useCallback } from 'react'
import { BookOpen, Plus, RefreshCw, RotateCcw, ShieldCheck, Workflow } from 'lucide-react'
import { cn } from '@/lib/class-names'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useActiveRepo } from '@/store/repos/use-repository-catalog'
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger
} from '@/components/ui/context-menu'
import { useWorkflowSelectionStore } from '../../workbench/workflow-presets'
import { buildSampleWorkflowYaml } from '../../workbench/workflow-yaml'
import {
  HARNESS_POLICY_REL_PATH,
  loadHarnessPolicy,
  saveHarnessPolicy
} from '../../workbench/harness-policy-io'

export function SidebarWorkflowNavButton(): React.JSX.Element {
  const t = useTranslate()
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
  const workbenchActive = activeView === 'workbench'

  const hiddenPresetIds = useWorkflowSelectionStore((s) => s.hiddenPresetIds)
  const setSelectedWorkflowId = useWorkflowSelectionStore((s) => s.setSelectedWorkflowId)
  const triggerWorkflowRefresh = useWorkflowSelectionStore((s) => s.triggerWorkflowRefresh)
  const restoreHiddenPresets = useWorkflowSelectionStore((s) => s.restoreHiddenPresets)

  const openFileInEditor = useCallback(
    (
      filePath: string,
      relativePath: string,
      language: string,
      mode: 'edit' | 'markdown-preview'
    ) => {
      const state = useAppStore.getState()
      state.openFile({
        filePath,
        relativePath,
        worktreeId: activeWorktreeId ?? '',
        language,
        mode
      })
      state.setActiveView('terminal')
    },
    [activeWorktreeId]
  )

  const handleCreateWorkflow = useCallback(async () => {
    if (!rootPath) {
      return
    }
    const slug = `workflow-${Date.now().toString().slice(-4)}`
    const fileName = `${slug}.yml`
    const relPath = `.orca/workflows/${fileName}`
    const filePath = `${rootPath.replace(/[\\/]+$/, '')}/${relPath}`
    const yamlContent = buildSampleWorkflowYaml(`Custom Workflow (${slug})`)
    await window.api.fs.writeFile({ filePath, content: yamlContent, connectionId })
    setSelectedWorkflowId(`yaml:${fileName}`)
    triggerWorkflowRefresh()
    openFileInEditor(filePath, relPath, 'yaml', 'edit')
  }, [connectionId, openFileInEditor, rootPath, setSelectedWorkflowId, triggerWorkflowRefresh])

  const handleEditHarness = useCallback(async () => {
    if (!rootPath) {
      return
    }
    const policy = await loadHarnessPolicy(rootPath, connectionId)
    const savedPath = await saveHarnessPolicy(policy, rootPath, connectionId)
    if (savedPath) {
      openFileInEditor(savedPath, HARNESS_POLICY_REL_PATH, 'yaml', 'edit')
    }
  }, [connectionId, openFileInEditor, rootPath])

  const handleOpenGuide = useCallback(() => {
    if (!rootPath) {
      return
    }
    const relPath = 'docs/workbench-yaml-guide.md'
    const filePath = `${rootPath.replace(/[\\/]+$/, '')}/${relPath}`
    openFileInEditor(filePath, relPath, 'markdown', 'markdown-preview')
  }, [openFileInEditor, rootPath])

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onClick={openWorkbenchPage}
          aria-current={workbenchActive ? 'page' : undefined}
          className={cn(
            'flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] font-medium tracking-tight transition-colors',
            workbenchActive
              ? 'bg-worktree-sidebar-accent text-worktree-sidebar-accent-foreground'
              : 'text-worktree-sidebar-foreground/60 hover:bg-worktree-sidebar-foreground/8'
          )}
        >
          <Workflow
            className={cn(
              'size-4 shrink-0',
              !workbenchActive && 'text-worktree-sidebar-foreground/30'
            )}
            strokeWidth={workbenchActive ? 2.25 : 1.75}
          />
          <span className="flex-1">
            {t('auto.components.sidebar.SidebarNav.workflow', 'Workflow')}
          </span>
        </button>
      </ContextMenuTrigger>

      <ContextMenuContent>
        <ContextMenuItem disabled={!rootPath} onSelect={() => void handleCreateWorkflow()}>
          <Plus className="size-3.5" />
          {t('workbench.workflowNavMenu.newWorkflow', '新建工作流')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={triggerWorkflowRefresh}>
          <RefreshCw className="size-3.5" />
          {t('workbench.workflowNavMenu.refresh', '刷新工作流列表')}
        </ContextMenuItem>
        <ContextMenuItem onSelect={openWorkbenchPage}>
          <Workflow className="size-3.5" />
          {t('workbench.workflowNavMenu.openWorkbench', '打开工作台')}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem disabled={!rootPath} onSelect={() => void handleEditHarness()}>
          <ShieldCheck className="size-3.5" />
          {t('workbench.workflowNavMenu.editHarness', '编辑 Harness 策略')}
        </ContextMenuItem>
        <ContextMenuItem disabled={!rootPath} onSelect={handleOpenGuide}>
          <BookOpen className="size-3.5" />
          {t('workbench.workflowNavMenu.openGuide', 'YAML 语法文档')}
        </ContextMenuItem>
        {hiddenPresetIds.length > 0 ? (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onSelect={restoreHiddenPresets}>
              <RotateCcw className="size-3.5" />
              {t('workbench.workflowNavMenu.restorePresets', '恢复隐藏的预设工作流')}
            </ContextMenuItem>
          </>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}
