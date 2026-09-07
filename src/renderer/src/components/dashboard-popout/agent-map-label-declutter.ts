import type { AgentMapLayout, AgentMapWorktreeRing } from './agent-map-layout'

/** Metrics for the label styles in agent-map.css. Estimating text extents from
 *  the character count avoids a per-frame DOM measure of every label. */
const WORKTREE_LABEL_FONT_PX = 12
const PROJECT_LABEL_FONT_PX = 13
const COUNT_FONT_PX = 11
const GLYPH_WIDTH_RATIO = 0.56
/** Uppercase project text runs wider per glyph than a mixed-case worktree name. */
const UPPERCASE_GLYPH_WIDTH_RATIO = 0.66
const ASCENT_RATIO = 0.8
const DESCENT_RATIO = 0.2
const PROJECT_LABEL_ICON_PX = 16
/** Local-unit breathing room so two labels never appear to touch. */
const LABEL_GAP_X_PX = 3
const LABEL_GAP_Y_PX = 1
const AGENT_LABEL_CLEARANCE_PX = 3
/** Baselines the scene renders at, relative to each label group's origin. */
const WORKTREE_LABEL_BASELINE = 18
const COUNT_BASELINE = 32
const PROJECT_NAME_TOP = 3
const PROJECT_NAME_BOTTOM = 21
/** Past this many candidates the pass stops admitting labels; a map that dense
 *  is unreadable long before the cap, and this bounds the work. */
const MAX_LABEL_CANDIDATES = 600
const DECLUTTER_GRID_PX = 96

/** A label box in world units, matching what the scene actually renders. */
type LabelBox = {
  left: number
  right: number
  top: number
  bottom: number
}

type LabelGrid = Map<number, Map<number, LabelBox[]>>

export type AgentMapVisibleLabels = {
  /** Worktree ring ids whose name can render without colliding. */
  worktreeIds: Set<string>
  /** Project ids whose agent/workspace count line still has room. The count is
   *  the first thing dropped: it repeats what the filter rail already says. */
  projectCountIds: Set<string>
}

function textWidth(text: string, fontPx: number, ratio = GLYPH_WIDTH_RATIO): number {
  return text.length * fontPx * ratio
}

function boxesOverlap(a: LabelBox, b: LabelBox): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
}

function addBox(grid: LabelGrid, box: LabelBox): void {
  const left = Math.floor(box.left / DECLUTTER_GRID_PX)
  const right = Math.floor(box.right / DECLUTTER_GRID_PX)
  const top = Math.floor(box.top / DECLUTTER_GRID_PX)
  const bottom = Math.floor(box.bottom / DECLUTTER_GRID_PX)
  for (let x = left; x <= right; x += 1) {
    let column = grid.get(x)
    if (!column) {
      column = new Map()
      grid.set(x, column)
    }
    for (let y = top; y <= bottom; y += 1) {
      const cell = column.get(y)
      if (cell) {
        cell.push(box)
      } else {
        column.set(y, [box])
      }
    }
  }
}

function collides(grid: LabelGrid, box: LabelBox): boolean {
  const left = Math.floor(box.left / DECLUTTER_GRID_PX)
  const right = Math.floor(box.right / DECLUTTER_GRID_PX)
  const top = Math.floor(box.top / DECLUTTER_GRID_PX)
  const bottom = Math.floor(box.bottom / DECLUTTER_GRID_PX)
  for (let x = left; x <= right; x += 1) {
    const column = grid.get(x)
    if (!column) {
      continue
    }
    for (let y = top; y <= bottom; y += 1) {
      for (const placed of column.get(y) ?? []) {
        if (boxesOverlap(box, placed)) {
          return true
        }
      }
    }
  }
  return false
}

/** Projects a centered label from its group's local units into world space
 *  through the same scale the scene applies to the group. */
function centeredBox(
  centerX: number,
  anchorY: number,
  scale: number,
  width: number,
  localTop: number,
  localBottom: number
): LabelBox {
  const halfWidth = (width / 2 + LABEL_GAP_X_PX) * scale
  return {
    left: centerX - halfWidth,
    right: centerX + halfWidth,
    top: anchorY + (localTop - LABEL_GAP_Y_PX) * scale,
    bottom: anchorY + (localBottom + LABEL_GAP_Y_PX) * scale
  }
}

/** Box for a centered <text> given its baseline in the group's local units. */
function baselineBox(
  centerX: number,
  anchorY: number,
  scale: number,
  text: string,
  fontPx: number,
  baseline: number,
  widthRatio = GLYPH_WIDTH_RATIO
): LabelBox {
  return centeredBox(
    centerX,
    anchorY,
    scale,
    textWidth(text, fontPx, widthRatio),
    baseline - fontPx * ASCENT_RATIO,
    baseline + fontPx * DESCENT_RATIO
  )
}

/** Attention outranks volume: a blocked workspace keeps its name when a large
 *  idle neighbour has to drop its own. */
function labelPriority(worktree: AgentMapWorktreeRing): number {
  const attention = worktree.statusCounts.blocked + worktree.statusCounts.waiting
  return (
    attention * 1_000_000 +
    worktree.statusCounts.working * 10_000 +
    worktree.statusCounts.monitoring * 1_000 +
    worktree.agents.length
  )
}

/** Worth drawing before collisions are considered: all-idle workspaces stay
 *  silent until their ring is big enough on screen to be worth naming. */
function isLabelCandidate(worktree: AgentMapWorktreeRing, mapScale: number): boolean {
  return !worktree.quiet || worktree.radius * mapScale >= 56
}

function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function addAgentExclusionBoxes(grid: LabelGrid, layout: AgentMapLayout, mapScale: number): void {
  const clearance = AGENT_LABEL_CLEARANCE_PX / Math.max(mapScale, 0.001)
  for (const project of layout.projects) {
    for (const worktree of project.worktrees) {
      for (const agent of worktree.agents) {
        if (!agent) {
          continue
        }
        const radius = agent.radius + clearance
        addBox(grid, {
          left: agent.x - radius,
          right: agent.x + radius,
          top: agent.y - radius,
          bottom: agent.y + radius
        })
      }
    }
  }
}

/**
 * Picks the labels that can render without stacking on each other. Labels draw
 * at a fixed screen size, so which ones fit depends on zoom but never on pan —
 * keeping this pan-independent is what lets the scene stay memoized during a
 * drag. Project names claim space first as the map's coarsest landmark,
 * workspace names next in priority order, and project counts take what is left.
 */
export function selectVisibleAgentMapLabels(
  layout: AgentMapLayout,
  labelScale: number,
  mapScale: number
): AgentMapVisibleLabels {
  const agentGrid: LabelGrid = new Map()
  addAgentExclusionBoxes(agentGrid, layout, mapScale)
  const grid: LabelGrid = new Map()
  addAgentExclusionBoxes(grid, layout, mapScale)
  for (const project of layout.projects) {
    const name = project.name.toUpperCase()
    addBox(
      grid,
      centeredBox(
        project.x,
        project.y - project.radius,
        labelScale,
        PROJECT_LABEL_ICON_PX + textWidth(name, PROJECT_LABEL_FONT_PX, UPPERCASE_GLYPH_WIDTH_RATIO),
        PROJECT_NAME_TOP,
        PROJECT_NAME_BOTTOM
      )
    )
  }

  const candidates: AgentMapWorktreeRing[] = []
  for (const project of layout.projects) {
    for (const worktree of project.worktrees) {
      if (isLabelCandidate(worktree, mapScale)) {
        candidates.push(worktree)
      }
    }
  }
  candidates.sort((a, b) => {
    const byPriority = labelPriority(b) - labelPriority(a)
    if (byPriority !== 0) {
      return byPriority
    }
    const byRadius = b.radius - a.radius
    return byRadius !== 0 ? byRadius : compareStable(a.id, b.id)
  })

  const worktreeIds = new Set<string>()
  for (const worktree of candidates.slice(0, MAX_LABEL_CANDIDATES)) {
    const box = baselineBox(
      worktree.x,
      worktree.y - worktree.radius,
      labelScale,
      worktree.name,
      WORKTREE_LABEL_FONT_PX,
      WORKTREE_LABEL_BASELINE
    )
    if (collides(agentGrid, box)) {
      continue
    }
    if (collides(grid, box)) {
      continue
    }
    addBox(grid, box)
    worktreeIds.add(worktree.id)
  }

  const projectCountIds = new Set<string>()
  for (const project of layout.projects) {
    const count = `${project.agentCount} AGENTS · ${project.worktrees.length} WORKSPACES`
    const box = baselineBox(
      project.x,
      project.y - project.radius,
      labelScale,
      count,
      COUNT_FONT_PX,
      COUNT_BASELINE,
      UPPERCASE_GLYPH_WIDTH_RATIO
    )
    if (collides(grid, box)) {
      continue
    }
    addBox(grid, box)
    projectCountIds.add(project.id)
  }

  return { worktreeIds, projectCountIds }
}
