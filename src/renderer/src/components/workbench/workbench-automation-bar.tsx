import { useState } from 'react'
import {
  Circle,
  CircleCheck,
  Filter,
  GitCommitHorizontal,
  GitMerge,
  Plus,
  ScanSearch,
  Terminal,
  UserCheck,
  Wrench,
  X
} from 'lucide-react'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import type { WorkflowNodeKind } from './workflow-presets'

export type AutomationStageState = {
  id: string
  label?: string
  kind?: string
  shell?: string
  agent?: string
  model?: string
  command?: string
  status: 'idle' | 'active' | 'pass' | 'attention'
}

const STAGE_ICONS: Record<string, typeof Circle> = {
  triage: Filter,
  analyze: Filter,
  locate: Filter,
  assess: Filter,
  approval: UserCheck,
  fix: Wrench,
  'fix-ci': Wrench,
  implement: Wrench,
  refactor: Wrench,
  review: ScanSearch,
  verify: CircleCheck,
  regression: CircleCheck,
  ci: CircleCheck,
  accept: CircleCheck,
  commit: GitCommitHorizontal,
  cli: Terminal,
  merge: GitMerge
}

const INSERTABLE_NODES: readonly {
  kind: WorkflowNodeKind
  labelKey: string
  labelFallback: string
  descKey: string
  descFallback: string
  icon: typeof Circle
}[] = [
  {
    kind: 'analyze',
    labelKey: 'auto.components.workbench.flow.tplAnalyzeLabel',
    labelFallback: '需求分析',
    descKey: 'auto.components.workbench.flow.insertAnalyzeDesc',
    descFallback: 'AI 拆解需求与定位文件',
    icon: Filter
  },
  {
    kind: 'implement',
    labelKey: 'auto.components.workbench.flow.tplImplementLabel',
    labelFallback: '编码实现',
    descKey: 'auto.components.workbench.flow.insertImplementDesc',
    descFallback: 'AI 编写与修改代码',
    icon: Wrench
  },
  {
    kind: 'cli',
    labelKey: 'auto.components.workbench.flow.tplCliLabel',
    labelFallback: 'CLI 命令',
    descKey: 'auto.components.workbench.flow.insertCliDesc',
    descFallback: '直接执行 Shell（不走模型）',
    icon: Terminal
  },
  {
    kind: 'verify',
    labelKey: 'auto.components.workbench.flow.tplVerifyLabel',
    labelFallback: '校验测试',
    descKey: 'auto.components.workbench.flow.insertVerifyDesc',
    descFallback: '类型检查 / 单元测试门禁',
    icon: CircleCheck
  },
  {
    kind: 'accept',
    labelKey: 'auto.components.workbench.flow.tplAcceptLabel',
    labelFallback: 'Diff 验收',
    descKey: 'auto.components.workbench.flow.insertAcceptDesc',
    descFallback: 'AI 审查改动质量',
    icon: ScanSearch
  },
  {
    kind: 'commit',
    labelKey: 'auto.components.workbench.flow.tplCommitLabel',
    labelFallback: '规范提交',
    descKey: 'auto.components.workbench.flow.insertCommitDesc',
    descFallback: '受 Harness 约束提交',
    icon: GitCommitHorizontal
  }
]

function InsertNodePopover({
  onInsert,
  compact
}: {
  onInsert: (kind: WorkflowNodeKind) => void
  compact?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const t = useTranslate()

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          title={t('auto.components.workbench.flow.insertNodeTitle', '插入节点')}
          className={
            compact
              ? 'flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground shadow-xs transition-all hover:scale-110 hover:border-primary hover:bg-primary hover:text-primary-foreground'
              : 'flex size-8 items-center justify-center rounded-xl border border-dashed border-border/90 bg-background/60 text-muted-foreground transition-colors hover:border-primary hover:bg-primary/10 hover:text-primary'
          }
        >
          <Plus className={compact ? 'size-3' : 'size-4'} />
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-56">
        <div className="p-1.5">
          <div className="px-2 py-1 text-[11px] font-medium text-muted-foreground">
            {t('auto.components.workbench.flow.insertNodeHeading', '插入新节点')}
          </div>
          <div className="flex flex-col gap-0.5">
            {INSERTABLE_NODES.map((item) => {
              const ItemIcon = item.icon
              return (
                <button
                  key={item.kind}
                  type="button"
                  onClick={() => {
                    onInsert(item.kind)
                    setOpen(false)
                  }}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-accent"
                >
                  <ItemIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="text-xs font-medium text-foreground">
                      {t(item.labelKey, item.labelFallback)}
                    </div>
                    <div className="truncate text-[10px] text-muted-foreground">
                      {t(item.descKey, item.descFallback)}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}

function FlowConnector({
  active,
  passed,
  onInsert
}: {
  active: boolean
  passed: boolean
  onInsert?: (kind: WorkflowNodeKind) => void
}): React.JSX.Element {
  return (
    <div className="group/edge relative flex w-10 shrink-0 items-center justify-center sm:w-12">
      <div
        className={`w-full border-t border-dashed ${
          active ? 'border-primary/70' : passed ? 'border-status-success/60' : 'border-border'
        }`}
      />
      {onInsert ? (
        <div className="absolute opacity-65 transition-opacity group-hover/edge:opacity-100">
          <InsertNodePopover compact onInsert={onInsert} />
        </div>
      ) : (
        <span
          className={`absolute size-2 rounded-full ${
            active
              ? 'bg-primary shadow-[0_0_8px_var(--color-primary)] animate-pulse'
              : passed
                ? 'bg-status-success'
                : 'bg-muted-foreground/35'
          }`}
        />
      )}
    </div>
  )
}

function StatusDot({ status }: { status: AutomationStageState['status'] }): React.JSX.Element {
  const color =
    status === 'active'
      ? 'bg-primary animate-pulse shadow-[0_0_6px_var(--color-primary)]'
      : status === 'pass'
        ? 'bg-status-success'
        : status === 'attention'
          ? 'bg-destructive'
          : 'bg-muted-foreground/40'
  return <span className={`inline-block size-2 shrink-0 rounded-full ${color}`} />
}

export function WorkbenchAutomationBar({
  stages,
  selectedNodeId,
  onSelectNode,
  onInsertNode,
  onDeleteNode
}: {
  stages: readonly AutomationStageState[]
  selectedNodeId?: string | null
  onSelectNode?: (nodeId: string) => void
  onInsertNode?: (index: number, kind: WorkflowNodeKind) => void
  onDeleteNode?: (nodeId: string) => void
}): React.JSX.Element {
  const t = useTranslate()

  return (
    <div className="rounded-2xl border border-border/70 bg-card/35 bg-[radial-gradient(circle,color-mix(in_srgb,var(--color-border)_65%,transparent)_1px,transparent_1px)] [background-size:18px_18px] px-5 py-7">
      <div className="flex flex-wrap items-center justify-center gap-y-4">
        {stages.map((stage, index) => {
          const Icon = STAGE_ICONS[stage.kind ?? ''] ?? STAGE_ICONS[stage.id] ?? Circle
          const selected = selectedNodeId === stage.id
          const prevStage = index > 0 ? stages[index - 1] : null
          const connectorActive = stage.status === 'active'
          const connectorPassed = prevStage?.status === 'pass' && stage.status !== 'idle'
          const label = stage.label ?? t(`auto.components.workbench.bar.${stage.id}`, stage.id)
          const agentSummary = [stage.agent, stage.model].filter(Boolean).join(' · ')
          const shellTag = stage.shell && stage.shell !== 'auto' ? `[${stage.shell}] ` : ''
          const subtitle =
            stage.kind === 'cli'
              ? stage.command
                ? `${shellTag}$ ${stage.command}`
                : `${shellTag}$ cli`
              : agentSummary || t('auto.components.workbench.flow.inheritAgent', 'Follow ChatUI')

          return (
            <div key={stage.id} className="flex items-center">
              {index > 0 ? (
                <FlowConnector
                  active={connectorActive}
                  passed={connectorPassed}
                  onInsert={onInsertNode ? (kind) => onInsertNode(index, kind) : undefined}
                />
              ) : null}

              <div className="group/node relative">
                <span className="pointer-events-none absolute top-1/2 -left-1 size-2 -translate-y-1/2 rounded-full border border-border bg-background" />
                <span className="pointer-events-none absolute top-1/2 -right-1 size-2 -translate-y-1/2 rounded-full border border-border bg-background" />

                <button
                  type="button"
                  onClick={() => onSelectNode?.(stage.id)}
                  className={`flex min-w-[140px] max-w-[184px] flex-col justify-between gap-2 rounded-xl border px-3.5 py-2.5 text-left shadow-xs transition-all ${
                    selected
                      ? 'border-primary bg-primary/10 ring-1 ring-primary/30'
                      : stage.status === 'active'
                        ? 'border-primary/60 bg-card'
                        : stage.status === 'attention'
                          ? 'border-destructive/60 bg-card/90'
                          : stage.status === 'pass'
                            ? 'border-status-success/40 bg-card/85'
                            : 'border-border/80 bg-card/90 hover:border-primary/50 hover:bg-card'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <StatusDot status={stage.status} />
                      <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="truncate text-xs font-medium text-foreground">{label}</span>
                    </div>
                  </div>

                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {subtitle}
                  </span>

                  <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
                    <div
                      className={`h-full rounded-full transition-all duration-300 ${
                        stage.status === 'attention'
                          ? 'w-full bg-destructive'
                          : stage.status === 'pass'
                            ? 'w-full bg-status-success'
                            : stage.status === 'active'
                              ? 'w-2/3 animate-pulse bg-primary'
                              : 'w-0'
                      }`}
                    />
                  </div>
                </button>

                {onDeleteNode && stages.length > 1 ? (
                  <button
                    type="button"
                    title={t('auto.components.workbench.flow.deleteNodeTitle', '删除节点')}
                    onClick={(e) => {
                      e.stopPropagation()
                      onDeleteNode(stage.id)
                    }}
                    className="absolute -top-2 -right-2 flex size-5 items-center justify-center rounded-full border border-border bg-background text-muted-foreground opacity-0 shadow-xs transition-opacity group-hover/node:opacity-100 hover:border-destructive hover:text-destructive"
                  >
                    <X className="size-3" />
                  </button>
                ) : null}
              </div>
            </div>
          )
        })}

        {onInsertNode ? (
          <div className="flex items-center">
            <div className="w-5 border-t border-dashed border-border" />
            <InsertNodePopover onInsert={(kind) => onInsertNode(stages.length, kind)} />
          </div>
        ) : null}
      </div>
    </div>
  )
}
