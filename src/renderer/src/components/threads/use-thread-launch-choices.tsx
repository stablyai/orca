import { useMemo, useState } from 'react'
import { useAppStore } from '@/store'
import { useNewTabAgentMenuRows } from '../tab-bar/use-new-tab-agent-menu-rows'
import { useAgentLaunchPickerInventory } from '../agent/use-agent-launch-picker-inventory'
import {
  agentPickerDraft,
  agentPickerEffectiveChoices,
  agentPickerLaunchInputs,
  editAgentPickerDraft,
  type AgentPickerDraft
} from '../../../../shared/agent-launch-picker'
import {
  AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
  agentChatPermissionModes,
  isAgentChatPermissionChoice
} from '../../../../shared/agent-chat-permission-mode'
import type {
  SessionOptionDescriptor,
  SessionOptionsSurface
} from '../../../../shared/native-chat/input/native-chat-session-options'
import type { ThreadProject } from './thread-projects'
import { workspaceKindForWorktreeId } from '../../../../shared/workspace-launch-kind'
import { ThreadLaunchPicker } from './ThreadLaunchPicker'

export function useThreadLaunchChoices(
  project: ThreadProject | undefined,
  focusComposer: () => void
) {
  const defaultAgent = useAppStore((s) => s.settings?.defaultTuiAgent)
  const [edited, setDraft] = useState<AgentPickerDraft | null>(null)
  const draft = useMemo<AgentPickerDraft>(
    () =>
      edited ?? {
        agent: defaultAgent && defaultAgent !== 'blank' ? defaultAgent : 'claude',
        surface: 'chat',
        choices: {}
      },
    [edited, defaultAgent]
  )
  const target = useMemo(
    () =>
      project?.hostId.startsWith('runtime:')
        ? {
            kind: 'runtime' as const,
            environmentId: project.hostId.slice(8),
            worktreeId: project.worktree.id
          }
        : project
          ? { kind: 'local' as const, worktreeId: project.worktree.id }
          : undefined,
    [project]
  )
  const menuTarget = useMemo(
    () => ({
      workspace: {
        kind: workspaceKindForWorktreeId(project?.worktree.id ?? ''),
        repoId: project?.repo.id,
        executionHostId: project?.hostId
      }
    }),
    [project?.worktree.id, project?.repo.id, project?.hostId]
  )
  const menu = useNewTabAgentMenuRows(menuTarget, !!project, target)
  const inventory = useAgentLaunchPickerInventory(
    project?.worktree.id,
    menu,
    !!project,
    draft.agent
  )
  const entries = inventory.filter((entry) => entry.surfaces.includes('chat'))
  const entry = entries.find((entry) => entry.agent === draft.agent)
  const effective = entry ? agentPickerEffectiveChoices(entry, draft) : draft.choices
  const settable = !!entry && !entry.structuredDefaultsPending
  const snapshot = useMemo(
    (): SessionOptionDescriptor[] => [
      {
        id: AGENT_CHAT_PERMISSION_MODE_OPTION_ID,
        label: 'Permissions',
        category: 'mode',
        kind: {
          type: 'select',
          currentValue: effective.permissionMode,
          choices: (agentChatPermissionModes(draft.agent)?.modes ?? []).map((value) => ({
            value,
            label: value
          }))
        },
        valueSource: effective.permissionMode ? 'default' : 'unknown',
        transport: 'agent-session',
        settable
      }
    ],
    [draft.agent, effective.permissionMode, settable]
  )
  const surface = useMemo(
    (): SessionOptionsSurface => ({
      getSnapshot: () => snapshot,
      setOption: async (id, value) => {
        if (id === AGENT_CHAT_PERMISSION_MODE_OPTION_ID && isAgentChatPermissionChoice(value)) {
          setDraft((current) => editAgentPickerDraft(current ?? draft, { permissionMode: value }))
        }
        return { snapshot }
      },
      invokeAction: async () => ({ snapshot }),
      subscribe: () => () => {}
    }),
    [snapshot, draft]
  )
  return {
    agent: draft.agent,
    launchInputs: agentPickerLaunchInputs(draft, entry),
    surface,
    snapshot,
    picker: (
      <ThreadLaunchPicker
        entries={entries}
        draft={draft}
        focusComposer={focusComposer}
        onSelect={(entry) =>
          setDraft((current) =>
            current?.agent === entry.agent ? current : agentPickerDraft(entry, 'chat')
          )
        }
        onModel={(model) =>
          setDraft((current) => editAgentPickerDraft(current ?? draft, { model }))
        }
      />
    )
  }
}
