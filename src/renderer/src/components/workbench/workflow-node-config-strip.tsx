import { useState } from 'react'
import { ArrowLeft, ArrowRight, Bot, Terminal, Trash2, X } from 'lucide-react'
import { Button } from '../ui/button'
import { Textarea } from '../ui/textarea'
import { useTranslate } from '@/i18n/use-translate'
import { AgentLaunchPicker } from '../agent/AgentLaunchPicker'
import type { NewTabAgentMenuModel } from '../agent/launch-menu/new-tab-agent-menu-model'
import type {
  AgentPickerDraft,
  AgentPickerEntry
} from '../../../../shared/agent-launch/picker/agent-launch-picker'
import { isTuiAgent } from '../../../../shared/agent-launch/catalog/tui-agent-config'
import type { WorkflowCliShell, WorkflowNodeDef, WorkflowNodeKind } from './workflow-presets'

export function WorkflowNodeConfigStrip({
  node,
  label,
  canMoveLeft,
  canMoveRight,
  canDelete,
  agentModel,
  worktreeId,
  hasYamlFile,
  onSave,
  onMove,
  onDelete,
  onClose
}: {
  node: WorkflowNodeDef
  label: string
  canMoveLeft: boolean
  canMoveRight: boolean
  canDelete: boolean
  agentModel: NewTabAgentMenuModel
  worktreeId?: string
  hasYamlFile: boolean
  onSave: (patch: {
    label?: string
    kind?: WorkflowNodeKind
    shell?: WorkflowCliShell
    agent?: string
    model?: string
    instruction?: string
  }) => void
  onMove: (direction: -1 | 1) => void
  onDelete: () => void
  onClose: () => void
}): React.JSX.Element {
  const t = useTranslate()
  const CLI_SHELL_OPTIONS: readonly { value: WorkflowCliShell; label: string }[] = [
    { value: 'auto', label: t('auto.components.workbench.flow.shellAuto', 'Auto (系统默认)') },
    { value: 'powershell', label: 'PowerShell' },
    { value: 'pwsh', label: 'PowerShell 7 (pwsh)' },
    { value: 'cmd', label: 'CMD' },
    { value: 'bash', label: 'Bash' },
    { value: 'sh', label: 'sh' },
    { value: 'wsl', label: 'WSL' }
  ]
  const [name, setName] = useState(label)
  const [isCli, setIsCli] = useState(node.kind === 'cli')
  const [shell, setShell] = useState<WorkflowCliShell>(node.shell ?? 'auto')
  const [agent, setAgent] = useState<AgentPickerEntry['agent'] | null>(() =>
    isTuiAgent(node.agent) ? node.agent : null
  )
  const [draft, setDraft] = useState<AgentPickerDraft | undefined>(() =>
    isTuiAgent(node.agent) && node.model
      ? {
          agent: node.agent,
          surface: 'chat',
          choices: { model: node.model }
        }
      : undefined
  )
  const [instruction, setInstruction] = useState(node.instruction ?? '')

  return (
    <div className="mx-auto flex w-full max-w-(--chat-content-max-width) flex-col gap-2.5 rounded-xl border border-primary/40 bg-card/80 p-3 text-card-foreground shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-medium text-foreground">
          <input
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('auto.components.workbench.flow.nodeNamePlaceholder', '节点名称')}
            className="w-32 rounded-md border border-border/70 bg-background/60 px-2 py-0.5 text-xs font-medium text-foreground outline-none focus:border-primary"
          />
          <div className="ml-1 flex items-center rounded-md border border-border/70 bg-background/60 p-0.5">
            <button
              type="button"
              onClick={() => setIsCli(false)}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                !isCli ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              <Bot className="size-3" />
              {t('auto.components.workbench.flow.modeAgent', 'AI Agent')}
            </button>
            <button
              type="button"
              onClick={() => setIsCli(true)}
              className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${
                isCli ? 'bg-primary text-primary-foreground' : 'text-muted-foreground'
              }`}
            >
              <Terminal className="size-3" />
              {t('auto.components.workbench.flow.modeCli', 'CLI Command')}
            </button>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isCli ? (
            <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>{t('auto.components.workbench.flow.runtimeEnvironment', '运行环境')}</span>
              <select
                value={shell}
                onChange={(e) => {
                  const next = CLI_SHELL_OPTIONS.find((opt) => opt.value === e.target.value)
                  if (next) {
                    setShell(next.value)
                  }
                }}
                className="h-7 rounded-md border border-border/70 bg-background/80 px-2 text-xs text-foreground outline-none focus:border-primary"
              >
                {CLI_SHELL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          ) : (
            <AgentLaunchPicker
              model={agentModel}
              worktreeId={worktreeId}
              agent={agent}
              value={draft}
              emptyLabel={t('auto.components.workbench.flow.inheritAgent', 'Follow ChatUI')}
              onSelectBlankTerminal={() => {
                setAgent(null)
                setDraft(undefined)
              }}
              onPick={(pickedAgent, pickedDraft) => {
                setAgent(pickedAgent)
                setDraft(pickedDraft)
              }}
            />
          )}
          <Button type="button" size="icon-xs" variant="ghost" onClick={onClose}>
            <X className="size-3.5" />
          </Button>
        </div>
      </div>

      <Textarea
        variant={isCli ? 'code' : 'default'}
        value={instruction}
        onChange={(e) => setInstruction(e.target.value)}
        placeholder={
          isCli || node.kind === 'verify'
            ? t(
                'auto.components.workbench.flow.nodeRunPlaceholder',
                'CLI command (e.g. pnpm tc && pnpm test)'
              )
            : t(
                'auto.components.workbench.flow.nodePromptPlaceholder',
                'Node prompt / instruction...'
              )
        }
        className="min-h-[60px] resize-none"
      />

      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!canMoveLeft}
            title={t('auto.components.workbench.flow.moveNodeLeft', '左移节点')}
            onClick={() => onMove(-1)}
          >
            <ArrowLeft className="size-3.5" />
          </Button>
          <Button
            type="button"
            size="icon-xs"
            variant="ghost"
            disabled={!canMoveRight}
            title={t('auto.components.workbench.flow.moveNodeRight', '右移节点')}
            onClick={() => onMove(1)}
          >
            <ArrowRight className="size-3.5" />
          </Button>
          {canDelete ? (
            <Button type="button" size="xs" variant="ghost-destructive" onClick={onDelete}>
              <Trash2 className="size-3" />
              {t('auto.components.workbench.flow.deleteNode', '删除')}
            </Button>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" size="xs" variant="ghost" onClick={onClose}>
            {t('auto.components.workbench.builder.cancel', 'Cancel')}
          </Button>
          <Button
            type="button"
            size="xs"
            onClick={() =>
              onSave({
                label: name.trim() || label,
                kind: isCli ? 'cli' : node.kind === 'cli' ? 'implement' : node.kind,
                shell: isCli ? shell : undefined,
                agent: isCli ? undefined : (agent ?? undefined),
                model: isCli ? undefined : (draft?.choices?.model ?? node.model ?? undefined),
                instruction: instruction.trim() || undefined
              })
            }
          >
            {hasYamlFile
              ? t('auto.components.workbench.flow.saveNodeYaml', 'Save to YAML')
              : t('auto.components.workbench.flow.applyNode', 'Apply')}
          </Button>
        </div>
      </div>
    </div>
  )
}
