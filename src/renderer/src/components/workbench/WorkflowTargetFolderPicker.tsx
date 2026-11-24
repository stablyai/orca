import { useState } from 'react'
import { Check, ChevronDown, Folder, FolderOpen, GitBranch } from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import { useAppStore } from '@/store/index'
import { useRepos } from '@/store/repos/use-repository-catalog'
import { selectFolderWorkspaces } from '@/store/workspaces/catalog/workspace-record-fields'
import { cn } from '@/lib/class-names'

function getFolderBaseName(path: string): string {
  const cleaned = path.replace(/[\\/]+$/, '')
  const parts = cleaned.split(/[\\/]/)
  return parts.at(-1) || path
}

export function WorkflowTargetFolderPicker({
  currentPath,
  currentLabel,
  disabled,
  onSelectTarget
}: {
  currentPath: string | null
  currentLabel: string | null
  disabled?: boolean
  onSelectTarget: (target: { repoId: string | null; dirPath: string | null }) => void
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const t = useTranslate()
  const repos = useRepos()
  const folderWorkspaces = useAppStore(selectFolderWorkspaces)

  const handleBrowseFolder = async (): Promise<void> => {
    setOpen(false)
    const picked = await window.api.shell
      .pickDirectory({ defaultPath: currentPath ?? undefined })
      .catch(() => window.api.repos.pickDirectory())
    if (!picked) {
      return
    }
    const matchedRepo = repos.find((r) => r.path === picked)
    onSelectTarget({ repoId: matchedRepo?.id ?? null, dirPath: picked })
  }

  const buttonLabel =
    currentLabel || (currentPath ? getFolderBaseName(currentPath) : '选择项目目录')

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          title={
            currentPath ??
            t('auto.components.workbench.flow.targetFolderTitle', '选择工作流运行目录')
          }
          className={cn(
            'inline-flex max-w-[200px] items-center gap-1.5 rounded-md border border-border/70 bg-background/60 px-2 py-1 text-[11px] font-medium text-foreground/90 transition-colors hover:border-border hover:bg-background disabled:opacity-50',
            !currentPath && 'border-dashed text-muted-foreground'
          )}
        >
          <Folder className="size-3.5 shrink-0 text-muted-foreground" />
          <span className="truncate">{buttonLabel}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </PopoverTrigger>

      <PopoverContent align="start" className="w-72">
        <div className="p-1.5">
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t('auto.components.workbench.flow.targetFolderHeading', '运行目录 / 项目')}
          </div>

          {repos.length > 0 ? (
            <div className="flex max-h-48 flex-col gap-0.5 overflow-y-auto scrollbar-sleek">
              {repos.map((r) => {
                const selected = currentPath === r.path
                return (
                  <button
                    key={r.id}
                    type="button"
                    onClick={() => {
                      onSelectTarget({ repoId: r.id, dirPath: r.path })
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <GitBranch className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {r.displayName}
                      </div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {r.path}
                      </div>
                    </div>
                    {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                  </button>
                )
              })}
            </div>
          ) : null}

          {folderWorkspaces.length > 0 ? (
            <div className="mt-1 flex max-h-36 flex-col gap-0.5 overflow-y-auto border-t border-border/60 pt-1 scrollbar-sleek">
              {folderWorkspaces.map((fw) => {
                const selected = currentPath === fw.folderPath
                return (
                  <button
                    key={fw.id}
                    type="button"
                    onClick={() => {
                      onSelectTarget({ repoId: null, dirPath: fw.folderPath })
                      setOpen(false)
                    }}
                    className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                  >
                    <Folder className="size-3.5 shrink-0 text-muted-foreground" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-xs font-medium text-foreground">
                        {fw.name || getFolderBaseName(fw.folderPath)}
                      </div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">
                        {fw.folderPath}
                      </div>
                    </div>
                    {selected ? <Check className="size-3.5 shrink-0 text-primary" /> : null}
                  </button>
                )
              })}
            </div>
          ) : null}

          <div className="mt-1 border-t border-border/60 pt-1">
            <button
              type="button"
              onClick={() => void handleBrowseFolder()}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs font-medium text-primary transition-colors hover:bg-accent"
            >
              <FolderOpen className="size-3.5 shrink-0" />
              <span>{t('auto.components.workbench.flow.browseFolder', '选择本地文件夹...')}</span>
            </button>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
