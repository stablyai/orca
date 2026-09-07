import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentMapAgentNode,
  AgentMapLayout,
  AgentMapProjectRing,
  AgentMapWorktreeRing
} from './agent-map-layout'

export const AGENT_MAP_EXIT_DURATION_MS = 260
export const AGENT_MAP_ENTER_DURATION_MS = 420

function allAgentIds(layout: AgentMapLayout): Set<string> {
  return new Set(
    layout.projects.flatMap((project) =>
      project.worktrees.flatMap((worktree) => worktree.agents.map((agent) => agent.card.paneKey))
    )
  )
}

function allWorktreeIds(layout: AgentMapLayout): Set<string> {
  return new Set(
    layout.projects.flatMap((project) => project.worktrees.map((worktree) => worktree.id))
  )
}

function retainMotionState<T extends { motionState?: 'entering' | 'exiting' }>(
  previous: T | undefined,
  next: T
): T {
  return {
    ...next,
    motionState: !previous
      ? 'entering'
      : previous.motionState === 'entering'
        ? 'entering'
        : undefined
  }
}

function reconcileAgents(
  previous: AgentMapWorktreeRing,
  next: AgentMapWorktreeRing,
  nextAgentIds: ReadonlySet<string>
): AgentMapAgentNode[] {
  const previousById = new Map(previous.agents.map((agent) => [agent.card.paneKey, agent]))
  const nextIds = new Set(next.agents.map((agent) => agent.card.paneKey))
  const agents = next.agents.map((agent) =>
    retainMotionState(previousById.get(agent.card.paneKey), agent)
  )

  for (const agent of previous.agents) {
    if (!nextIds.has(agent.card.paneKey) && !nextAgentIds.has(agent.card.paneKey)) {
      agents.push({ ...agent, motionState: 'exiting' })
    }
  }
  return agents
}

function enteringWorktree(worktree: AgentMapWorktreeRing): AgentMapWorktreeRing {
  return {
    ...worktree,
    motionState: 'entering',
    agents: worktree.agents.map((agent) => ({ ...agent, motionState: undefined }))
  }
}

function exitingWorktree(worktree: AgentMapWorktreeRing): AgentMapWorktreeRing {
  return {
    ...worktree,
    motionState: 'exiting',
    agents: worktree.agents.map((agent) => ({ ...agent, motionState: undefined }))
  }
}

function reconcileWorktrees(
  previous: AgentMapProjectRing,
  next: AgentMapProjectRing,
  nextAgentIds: ReadonlySet<string>,
  nextWorktreeIds: ReadonlySet<string>
): AgentMapWorktreeRing[] {
  const previousById = new Map(previous.worktrees.map((worktree) => [worktree.id, worktree]))
  const nextIds = new Set(next.worktrees.map((worktree) => worktree.id))
  const worktrees = next.worktrees.map((worktree) => {
    const previousWorktree = previousById.get(worktree.id)
    if (!previousWorktree) {
      return enteringWorktree(worktree)
    }
    return {
      ...retainMotionState(previousWorktree, worktree),
      agents: reconcileAgents(previousWorktree, worktree, nextAgentIds)
    }
  })

  for (const worktree of previous.worktrees) {
    if (!nextIds.has(worktree.id) && !nextWorktreeIds.has(worktree.id)) {
      worktrees.push(exitingWorktree(worktree))
    }
  }
  return worktrees
}

function enteringProject(project: AgentMapProjectRing): AgentMapProjectRing {
  return {
    ...project,
    motionState: 'entering',
    worktrees: project.worktrees.map((worktree) => ({
      ...worktree,
      motionState: undefined,
      agents: worktree.agents.map((agent) => ({ ...agent, motionState: undefined }))
    }))
  }
}

function exitingProject(project: AgentMapProjectRing): AgentMapProjectRing {
  return {
    ...project,
    motionState: 'exiting',
    worktrees: project.worktrees.map((worktree) => ({
      ...worktree,
      motionState: undefined,
      agents: worktree.agents.map((agent) => ({ ...agent, motionState: undefined }))
    }))
  }
}

export function reconcileAgentMapMotionLayout(
  previous: AgentMapLayout,
  next: AgentMapLayout
): AgentMapLayout {
  const previousById = new Map(previous.projects.map((project) => [project.id, project]))
  const nextProjectIds = new Set(next.projects.map((project) => project.id))
  const nextAgentIds = allAgentIds(next)
  const nextWorktreeIds = allWorktreeIds(next)
  const projects = next.projects.map((project) => {
    const previousProject = previousById.get(project.id)
    if (!previousProject) {
      return enteringProject(project)
    }
    return {
      ...retainMotionState(previousProject, project),
      worktrees: reconcileWorktrees(previousProject, project, nextAgentIds, nextWorktreeIds)
    }
  })

  for (const project of previous.projects) {
    if (!nextProjectIds.has(project.id)) {
      projects.push(exitingProject(project))
    }
  }
  return {
    ...next,
    projects
  }
}

function motionNodeSignature(layout: AgentMapLayout, motionState: 'entering' | 'exiting'): string {
  const nodeIds = layout.projects.flatMap((project) => [
    ...(project.motionState === motionState ? [`project:${project.id}`] : []),
    ...project.worktrees.flatMap((worktree) => [
      ...(worktree.motionState === motionState ? [`worktree:${worktree.id}`] : []),
      ...worktree.agents
        .filter((agent) => agent.motionState === motionState)
        .map((agent) => `agent:${agent.card.paneKey}`)
    ])
  ])
  return nodeIds.length > 0 ? JSON.stringify(nodeIds) : ''
}

function clearEnteringAgentMapLayout(layout: AgentMapLayout): AgentMapLayout {
  return {
    ...layout,
    projects: layout.projects.map((project) => ({
      ...project,
      motionState: project.motionState === 'entering' ? undefined : project.motionState,
      worktrees: project.worktrees.map((worktree) => ({
        ...worktree,
        motionState: worktree.motionState === 'entering' ? undefined : worktree.motionState,
        agents: worktree.agents.map((agent) => ({
          ...agent,
          motionState: agent.motionState === 'entering' ? undefined : agent.motionState
        }))
      }))
    }))
  }
}

export function pruneExitingAgentMapLayout(layout: AgentMapLayout): AgentMapLayout {
  return {
    ...layout,
    projects: layout.projects
      .filter((project) => project.motionState !== 'exiting')
      .map((project) => ({
        ...project,
        worktrees: project.worktrees
          .filter((worktree) => worktree.motionState !== 'exiting')
          .map((worktree) => ({
            ...worktree,
            agents: worktree.agents.filter((agent) => agent.motionState !== 'exiting')
          }))
      }))
  }
}

export function useAgentMapMotionLayout(
  layout: AgentMapLayout,
  reducedMotion: boolean
): AgentMapLayout {
  const [motionState, setMotionState] = useState(() => ({
    inputLayout: layout,
    reducedMotion,
    motionLayout: layout
  }))
  const enterTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  let motionLayout = motionState.motionLayout
  // Reconcile before commit so metadata refreshes do not render the full scene twice.
  if (motionState.inputLayout !== layout || motionState.reducedMotion !== reducedMotion) {
    motionLayout = reducedMotion
      ? layout
      : reconcileAgentMapMotionLayout(motionState.motionLayout, layout)
    setMotionState({ inputLayout: layout, reducedMotion, motionLayout })
  }

  const { enteringSignature, exitingSignature } = useMemo(
    () => ({
      enteringSignature: motionNodeSignature(motionLayout, 'entering'),
      exitingSignature: motionNodeSignature(motionLayout, 'exiting')
    }),
    [motionLayout]
  )

  useEffect(() => {
    if (enterTimerRef.current) {
      clearTimeout(enterTimerRef.current)
      enterTimerRef.current = null
    }
    if (reducedMotion || !enteringSignature) {
      return
    }
    enterTimerRef.current = setTimeout(() => {
      enterTimerRef.current = null
      setMotionState((previous) => ({
        ...previous,
        motionLayout: clearEnteringAgentMapLayout(previous.motionLayout)
      }))
    }, AGENT_MAP_ENTER_DURATION_MS)
    return () => {
      if (enterTimerRef.current) {
        clearTimeout(enterTimerRef.current)
        enterTimerRef.current = null
      }
    }
  }, [enteringSignature, reducedMotion])

  useEffect(() => {
    if (exitTimerRef.current) {
      clearTimeout(exitTimerRef.current)
      exitTimerRef.current = null
    }
    if (reducedMotion || !exitingSignature) {
      return
    }
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null
      setMotionState((previous) => ({
        ...previous,
        motionLayout: pruneExitingAgentMapLayout(previous.motionLayout)
      }))
    }, AGENT_MAP_EXIT_DURATION_MS)
    return () => {
      if (exitTimerRef.current) {
        clearTimeout(exitTimerRef.current)
        exitTimerRef.current = null
      }
    }
  }, [exitingSignature, reducedMotion])

  return motionLayout
}
