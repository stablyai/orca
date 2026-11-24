import { BookOpen, HelpCircle } from 'lucide-react'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useTranslate } from '@/i18n/use-translate'

export function WorkflowYamlGuidePopover({
  hasRepo,
  onOpenGuideDoc
}: {
  hasRepo: boolean
  onOpenGuideDoc: () => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="ghost">
          <HelpCircle className="size-3.5" />
          {t('workbench.yamlGuide.button', '语法说明')}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-96">
        <div className="p-3 text-xs">
          <div className="mb-2 flex items-center justify-between gap-2">
            <span className="font-semibold text-foreground">
              {t('workbench.yamlGuide.title', 'Workflow YAML 速查')}
            </span>
            <span className="font-mono text-[10px] text-muted-foreground">
              .orca/workflows/*.yml
            </span>
          </div>

          <div className="space-y-2 text-[11px] leading-relaxed text-muted-foreground">
            <div>
              <span className="font-medium text-foreground">
                {t('workbench.yamlGuide.topFields', '顶层字段：')}
              </span>
              <code className="rounded bg-muted px-1">name</code>、
              <code className="rounded bg-muted px-1">description</code>、
              <code className="rounded bg-muted px-1">steps</code>
            </div>

            <div>
              <div className="mb-1 font-medium text-foreground">
                {t('workbench.yamlGuide.stepsHeading', '步骤节点（steps[]）：')}
              </div>
              <ul className="space-y-0.5 pl-3">
                <li>
                  <code className="rounded bg-muted px-1">id</code> /{' '}
                  <code className="rounded bg-muted px-1">name</code>
                  {t('workbench.yamlGuide.idNameDesc', '：节点标识与显示名称')}
                </li>
                <li>
                  <code className="rounded bg-muted px-1">kind</code>：
                  <code className="text-foreground">analyze</code> ·{' '}
                  <code className="text-foreground">implement</code> ·{' '}
                  <code className="text-foreground">verify</code> ·{' '}
                  <code className="text-foreground">accept</code> ·{' '}
                  <code className="text-foreground">commit</code> ·{' '}
                  <code className="text-foreground">cli</code>
                </li>
                <li>
                  <code className="rounded bg-muted px-1">prompt</code>
                  {t(
                    'workbench.yamlGuide.promptDesc',
                    '：AI 节点指令（用于 analyze/implement/accept/commit）'
                  )}
                </li>
                <li>
                  <code className="rounded bg-muted px-1">run</code>
                  {t('workbench.yamlGuide.runDesc', '：Shell 命令（用于 cli/verify，不走大模型）')}
                </li>
                <li>
                  <code className="rounded bg-muted px-1">agent</code> /{' '}
                  <code className="rounded bg-muted px-1">model</code>
                  {t('workbench.yamlGuide.agentModelDesc', '：可选，单独覆盖节点模型')}
                </li>
              </ul>
            </div>

            <pre className="overflow-x-auto rounded-md border border-border/60 bg-muted/40 p-2 font-mono text-[10px] leading-snug text-foreground">
              {t(
                'workbench.yamlGuide.sample',
                `steps:
  - id: analyze
    name: 需求分析
    kind: analyze
    prompt: 分析需求并定位目标文件
  - id: check
    name: 类型检查
    kind: cli
    run: pnpm tc:web`
              )}
            </pre>

            {hasRepo ? (
              <div className="flex justify-end pt-1">
                <Button type="button" size="xs" variant="outline" onClick={onOpenGuideDoc}>
                  <BookOpen className="size-3" />
                  {t('workbench.yamlGuide.openDoc', '打开完整文档')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
