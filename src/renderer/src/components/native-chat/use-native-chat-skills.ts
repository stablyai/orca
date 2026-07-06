import { useEffect, useState } from 'react'
import { useAppStore } from '../../store'
import type { AgentType } from '../../../../shared/agent-status-types'
import type { DiscoveredSkill } from '../../../../shared/skills'

type NativeChatSkillWorktreeState = {
  tabsByWorktree: Record<string, readonly { id: string }[]>
  worktreesByRepo: Record<string, readonly { id: string; path: string }[]>
}

export function isNativeChatSkillForAgent(agent: AgentType, skill: DiscoveredSkill): boolean {
  if (agent !== 'codex') {
    return false
  }
  // Why: Codex sessions can see both Codex-native skills and generic agent
  // skills (for example ~/.agents/skills), so the picker should mirror that.
  return skill.providers.includes('codex') || skill.providers.includes('agent-skills')
}

export function resolveNativeChatSkillDiscoveryCwd(
  state: NativeChatSkillWorktreeState,
  terminalTabId: string
): string | null {
  let ownerWorktreeId: string | null = null
  for (const [worktreeId, tabs] of Object.entries(state.tabsByWorktree)) {
    if (tabs.some((tab) => tab.id === terminalTabId)) {
      ownerWorktreeId = worktreeId
      break
    }
  }
  if (!ownerWorktreeId) {
    return null
  }
  for (const worktrees of Object.values(state.worktreesByRepo)) {
    const worktree = worktrees.find((entry) => entry.id === ownerWorktreeId)
    if (worktree) {
      return worktree.path
    }
  }
  return null
}

export function useNativeChatSkills(agent: AgentType, terminalTabId: string): DiscoveredSkill[] {
  const [skills, setSkills] = useState<DiscoveredSkill[]>([])
  const cwd = useAppStore((state) => resolveNativeChatSkillDiscoveryCwd(state, terminalTabId))

  useEffect(() => {
    let cancelled = false
    if (agent !== 'codex') {
      setSkills([])
      return
    }
    void window.api.skills
      .discover(cwd ? { cwd } : undefined)
      .then((result) => {
        if (!cancelled) {
          setSkills(result.skills.filter((skill) => isNativeChatSkillForAgent(agent, skill)))
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSkills([])
        }
      })
    return () => {
      cancelled = true
    }
  }, [agent, cwd])

  return skills
}
