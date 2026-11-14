import { HostCombobox, type HostComboboxOption } from '@/components/host-picker/HostCombobox'
import { WorkspaceCombobox } from '@/components/automations/authoring/WorkspaceCombobox'
import { Label } from '@/components/ui/label'
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from '@/components/ui/select'
import { useTranslate } from '@/i18n/use-translate'
import { getAgentLabel } from '@/lib/agent-catalog/agent-catalog'
import type { TuiAgent } from '../../../../../../../shared/agent-launch/catalog/tui-agent'
import type { Worktree } from '../../../../../../../shared/worktree/types'
import type {
  NativeChatForkHostChoice,
  NativeChatForkRunAs,
  NativeChatForkWorkspaceChoice
} from './native-chat-fork-window-choices'

type WorkspaceKind = NativeChatForkWorkspaceChoice['kind']

function isWorkspaceKind(value: string): value is WorkspaceKind {
  return value === 'this' || value === 'new-worktree' || value === 'existing'
}

function isRunAs(value: string): value is NativeChatForkRunAs {
  return value === 'open' || value === 'subagent'
}

/** Host, workspace, agent and run mode, each already set to the window's default. */
export function NativeChatForkWindowTargetFields(props: {
  id: string
  busy: boolean
  hosts: readonly NativeChatForkHostChoice[]
  hostId: string
  onHostChange: (hostId: string) => void
  workspaceKinds: readonly WorkspaceKind[]
  workspace: NativeChatForkWorkspaceChoice
  worktrees: Worktree[]
  onWorkspaceChange: (workspace: NativeChatForkWorkspaceChoice) => void
  agents: readonly TuiAgent[]
  agent: TuiAgent
  detectingAgents: boolean
  onAgentChange: (agent: TuiAgent) => void
  runAs: NativeChatForkRunAs
  /** False where the chat can't start a subagent at all (terminal chats). */
  runAsShown: boolean
  subagentAllowed: boolean
  onRunAsChange: (runAs: NativeChatForkRunAs) => void
}): React.JSX.Element {
  const t = useTranslate()
  const { id, busy } = props
  const hostOptions = props.hosts.map((host, index): HostComboboxOption => ({
    id: host.id,
    label: host.label,
    disabled: host.disabled,
    detail:
      index === 0
        ? t('components.native-chat.fork.window.sourceHost', '· this chat’s host')
        : host.blocked === 'needs-update'
          ? t('components.native-chat.fork.window.hostNeedsUpdate', '— update Orca on this host')
          : host.blocked === 'offline'
            ? t('components.native-chat.fork.window.hostOffline', '— not connected')
            : undefined
  }))
  const kindLabel: Record<WorkspaceKind, string> = {
    this: t('components.native-chat.fork.window.workspaceThis', 'This workspace, in a new tab'),
    'new-worktree': t('components.native-chat.fork.window.workspaceNew', 'A new worktree'),
    existing: t('components.native-chat.fork.window.workspaceExisting', 'Another workspace')
  }
  const existingId = props.workspace.kind === 'existing' ? props.workspace.worktreeId : ''
  return (
    <>
      {props.hosts.length > 1 ? (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${id}-host`}>
            {t('components.native-chat.fork.window.hostLabel', 'Host')}
          </Label>
          <HostCombobox
            id={`${id}-host`}
            value={props.hostId}
            options={hostOptions}
            disabled={busy}
            onChange={props.onHostChange}
          />
        </div>
      ) : null}
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-workspace`}>
          {t('components.native-chat.fork.window.workspaceLabel', 'Workspace')}
        </Label>
        {props.workspaceKinds.length > 1 ? (
          <Select
            value={props.workspace.kind}
            disabled={busy}
            onValueChange={(value) => {
              if (isWorkspaceKind(value)) {
                props.onWorkspaceChange(
                  value === 'existing'
                    ? { kind: 'existing', worktreeId: props.worktrees[0]?.id ?? '' }
                    : { kind: value }
                )
              }
            }}
          >
            <SelectTrigger id={`${id}-workspace`} className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {props.workspaceKinds.map((kind) => (
                <SelectItem key={kind} value={kind}>
                  {kindLabel[kind]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
        {props.workspace.kind === 'existing' ? (
          props.worktrees.length > 0 ? (
            <WorkspaceCombobox
              worktrees={props.worktrees}
              value={existingId}
              triggerClassName="w-full"
              onValueChange={(worktreeId) =>
                props.onWorkspaceChange({ kind: 'existing', worktreeId })
              }
            />
          ) : (
            <p className="text-xs text-muted-foreground">
              {t(
                'components.native-chat.fork.window.noWorkspaces',
                'No other workspaces on this host yet. Add a project there first.'
              )}
            </p>
          )
        ) : null}
      </div>
      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${id}-agent`}>
          {t('components.native-chat.fork.window.agentLabel', 'Agent')}
        </Label>
        <Select
          value={props.agent}
          disabled={busy}
          onValueChange={(value) => {
            const picked = props.agents.find((agent) => agent === value)
            if (picked) {
              props.onAgentChange(picked)
            }
          }}
        >
          <SelectTrigger id={`${id}-agent`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {props.agents.map((agent, index) => (
              <SelectItem key={agent} value={agent}>
                {index === 0
                  ? t('components.native-chat.fork.window.sameAgent', '{{agent}} (same agent)', {
                      agent: getAgentLabel(agent)
                    })
                  : getAgentLabel(agent)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {props.detectingAgents ? (
          <p className="text-xs text-muted-foreground">
            {t(
              'components.native-chat.fork.window.detectingAgents',
              'Looking for other agents on this host…'
            )}
          </p>
        ) : null}
      </div>
      {props.runAsShown ? (
        <RadioGroup
          value={props.runAs}
          disabled={busy}
          onValueChange={(value) => {
            if (isRunAs(value)) {
              props.onRunAsChange(value)
            }
          }}
          aria-label={t('components.native-chat.fork.window.runAsLabel', 'Run as')}
        >
          <div className="flex items-center gap-2">
            <RadioGroupItem id={`${id}-open`} value="open" />
            <Label htmlFor={`${id}-open`}>
              {t('components.native-chat.fork.window.runAsOpen', 'Open it')}
            </Label>
          </div>
          <div className="flex items-start gap-2">
            <RadioGroupItem
              id={`${id}-subagent`}
              value="subagent"
              disabled={!props.subagentAllowed}
              className="mt-0.5"
            />
            <div className="flex flex-col items-start gap-0.5">
              <Label htmlFor={`${id}-subagent`}>
                {t('components.native-chat.fork.window.runAsSubagent', 'Background subagent')}
              </Label>
              <span className="text-xs text-muted-foreground">
                {t(
                  'components.native-chat.fork.window.runAsSubagentHint',
                  'Works on a task in another workspace on this host with the same agent, and reports back here.'
                )}
              </span>
            </div>
          </div>
        </RadioGroup>
      ) : null}
    </>
  )
}
