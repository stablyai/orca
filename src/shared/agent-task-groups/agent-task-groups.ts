/**
 * Task groups organize a workspace's agent conversations in the sidebar. They are presentation
 * only: a group owns no directory, branch, worktree, process, or transcript.
 */
export type AgentTaskGroup = {
  id: string
  name: string
  createdAt: number
  collapsed?: true
}

export type WorkspaceAgentTaskGroups = {
  /** Display order. */
  groups: AgentTaskGroup[]
  /** Conversation membership by persisted terminal tab id; absent tabs stay ungrouped. */
  groupIdByTabId: Record<string, string>
}

/** Keyed by host-qualified workspace identity, so local and remote copies of a workspace stay apart. */
export type AgentTaskGroupsByWorkspace = Record<string, WorkspaceAgentTaskGroups>

export const MAX_AGENT_TASK_GROUP_WORKSPACES = 1000
export const MAX_AGENT_TASK_GROUPS_PER_WORKSPACE = 64
export const MAX_AGENT_TASK_GROUP_MEMBERS_PER_WORKSPACE = 2000
export const MAX_AGENT_TASK_GROUP_NAME_LENGTH = 120
const MAX_ID_LENGTH = 512

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_ID_LENGTH
}

export function normalizeAgentTaskGroupName(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const name = value.replace(/\s+/g, ' ').trim().slice(0, MAX_AGENT_TASK_GROUP_NAME_LENGTH)
  return name.length > 0 ? name : null
}

function normalizeWorkspaceGroups(value: unknown): WorkspaceAgentTaskGroups | null {
  if (!isRecord(value) || !Array.isArray(value.groups)) {
    return null
  }
  const groups: AgentTaskGroup[] = []
  const ids = new Set<string>()
  for (const raw of value.groups) {
    if (groups.length >= MAX_AGENT_TASK_GROUPS_PER_WORKSPACE) {
      break
    }
    if (!isRecord(raw) || !isId(raw.id) || ids.has(raw.id)) {
      continue
    }
    const name = normalizeAgentTaskGroupName(raw.name)
    if (!name) {
      continue
    }
    ids.add(raw.id)
    groups.push({
      id: raw.id,
      name,
      createdAt:
        typeof raw.createdAt === 'number' && Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
      ...(raw.collapsed === true ? { collapsed: true as const } : {})
    })
  }
  if (groups.length === 0) {
    return null
  }
  const groupIdByTabId: Record<string, string> = {}
  let members = 0
  if (isRecord(value.groupIdByTabId)) {
    for (const [tabId, groupId] of Object.entries(value.groupIdByTabId)) {
      if (members >= MAX_AGENT_TASK_GROUP_MEMBERS_PER_WORKSPACE) {
        break
      }
      // A membership naming a missing group falls back to ungrouped rather than hiding the tab.
      if (isId(tabId) && typeof groupId === 'string' && ids.has(groupId)) {
        groupIdByTabId[tabId] = groupId
        members++
      }
    }
  }
  return { groups, groupIdByTabId }
}

/** Accepts any persisted value; never throws and never invents groups. */
export function normalizeAgentTaskGroupsByWorkspace(value: unknown): AgentTaskGroupsByWorkspace {
  const result: AgentTaskGroupsByWorkspace = {}
  if (!isRecord(value)) {
    return result
  }
  let workspaces = 0
  for (const [workspaceKey, raw] of Object.entries(value)) {
    if (workspaces >= MAX_AGENT_TASK_GROUP_WORKSPACES) {
      break
    }
    const normalized = isId(workspaceKey) ? normalizeWorkspaceGroups(raw) : null
    if (normalized) {
      result[workspaceKey] = normalized
      workspaces++
    }
  }
  return result
}

function updateWorkspace(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  update: (current: WorkspaceAgentTaskGroups) => WorkspaceAgentTaskGroups | null
): AgentTaskGroupsByWorkspace {
  const current = state[workspaceKey] ?? { groups: [], groupIdByTabId: {} }
  const next = update(current)
  if (next === current) {
    return state
  }
  const result = { ...state }
  if (!next || next.groups.length === 0) {
    delete result[workspaceKey]
  } else {
    result[workspaceKey] = next
  }
  return result
}

export function createAgentTaskGroup(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  group: { id: string; name: string; createdAt: number }
): AgentTaskGroupsByWorkspace {
  const name = normalizeAgentTaskGroupName(group.name)
  return updateWorkspace(state, workspaceKey, (current) =>
    !name ||
    !isId(group.id) ||
    current.groups.length >= MAX_AGENT_TASK_GROUPS_PER_WORKSPACE ||
    current.groups.some((existing) => existing.id === group.id)
      ? current
      : {
          ...current,
          groups: [...current.groups, { id: group.id, name, createdAt: group.createdAt }]
        }
  )
}

function mapGroup(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  groupId: string,
  map: (group: AgentTaskGroup) => AgentTaskGroup
): AgentTaskGroupsByWorkspace {
  return updateWorkspace(state, workspaceKey, (current) => {
    const index = current.groups.findIndex((group) => group.id === groupId)
    if (index === -1) {
      return current
    }
    const updated = map(current.groups[index])
    if (updated === current.groups[index]) {
      return current
    }
    const groups = [...current.groups]
    groups[index] = updated
    return { ...current, groups }
  })
}

export function renameAgentTaskGroup(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  groupId: string,
  name: string
): AgentTaskGroupsByWorkspace {
  const nextName = normalizeAgentTaskGroupName(name)
  return mapGroup(state, workspaceKey, groupId, (group) =>
    !nextName || nextName === group.name ? group : { ...group, name: nextName }
  )
}

export function setAgentTaskGroupCollapsed(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  groupId: string,
  collapsed: boolean
): AgentTaskGroupsByWorkspace {
  return mapGroup(state, workspaceKey, groupId, (group) => {
    if (Boolean(group.collapsed) === collapsed) {
      return group
    }
    const { collapsed: _omit, ...rest } = group
    return collapsed ? { ...rest, collapsed: true } : rest
  })
}

export function moveAgentTaskGroup(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  groupId: string,
  offset: -1 | 1
): AgentTaskGroupsByWorkspace {
  return updateWorkspace(state, workspaceKey, (current) => {
    const index = current.groups.findIndex((group) => group.id === groupId)
    const target = index + offset
    if (index === -1 || target < 0 || target >= current.groups.length) {
      return current
    }
    const groups = [...current.groups]
    ;[groups[index], groups[target]] = [groups[target], groups[index]]
    return { ...current, groups }
  })
}

/** Removes only the organizational container; its conversations become ungrouped. */
export function deleteAgentTaskGroup(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  groupId: string
): AgentTaskGroupsByWorkspace {
  return updateWorkspace(state, workspaceKey, (current) => {
    if (!current.groups.some((group) => group.id === groupId)) {
      return current
    }
    const groupIdByTabId: Record<string, string> = {}
    for (const [tabId, memberGroupId] of Object.entries(current.groupIdByTabId)) {
      if (memberGroupId !== groupId) {
        groupIdByTabId[tabId] = memberGroupId
      }
    }
    return { groups: current.groups.filter((group) => group.id !== groupId), groupIdByTabId }
  })
}

/** `groupId: null` returns the conversation to the ungrouped list. */
export function assignTabToAgentTaskGroup(
  state: AgentTaskGroupsByWorkspace,
  workspaceKey: string,
  tabId: string,
  groupId: string | null
): AgentTaskGroupsByWorkspace {
  return updateWorkspace(state, workspaceKey, (current) => {
    if (!isId(tabId) || (current.groupIdByTabId[tabId] ?? null) === groupId) {
      return current
    }
    if (groupId !== null && !current.groups.some((group) => group.id === groupId)) {
      return current
    }
    const groupIdByTabId = { ...current.groupIdByTabId }
    if (groupId === null) {
      delete groupIdByTabId[tabId]
    } else if (Object.keys(groupIdByTabId).length >= MAX_AGENT_TASK_GROUP_MEMBERS_PER_WORKSPACE) {
      return current
    } else {
      groupIdByTabId[tabId] = groupId
    }
    return { ...current, groupIdByTabId }
  })
}
