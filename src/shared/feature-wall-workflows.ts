import {
  FEATURE_WALL_TILES,
  isFeatureWallMediaTile,
  type FeatureWallMediaTile,
  type FeatureWallMediaTileId
} from './feature-wall-tiles'

export type FeatureWallWorkflowId =
  | 'tasks'
  | 'workspaces'
  | 'agents-orchestration'
  | 'workbench'
  | 'review'

// Bullets can be a plain sentence or a {leadIn, body} pair so workflows that
// want a short bold "headline" segment (e.g. workbench → "Splits, by keystroke
// or right-click.") can render it inline before the rest of the bullet copy.
export type FeatureWallWorkflowBullet =
  | string
  | {
      readonly leadIn: string
      readonly body: string
    }

export type FeatureWallWorkflow = {
  id: FeatureWallWorkflowId
  title: string
  meta: string
  lede: string
  bullets: readonly FeatureWallWorkflowBullet[]
  primaryTileId: FeatureWallMediaTileId
  relatedTileIds: readonly FeatureWallMediaTileId[]
  docsUrl: string
}

export const FEATURE_WALL_WORKFLOWS: readonly FeatureWallWorkflow[] = [
  {
    id: 'workspaces',
    title: 'Workspaces',
    meta: 'Isolated work · Context kept together',
    lede: 'Each piece of work gets its own workspace: isolated branch, terminal, editor, and agent state, all kept together.',
    bullets: [
      'Run agents in parallel: one workspace per task, no cross-talk.',
      'Switch instantly. Terminal, files, and browser restore intact.',
      'Sleep a workspace to free memory. Wake it later with state intact.'
    ],
    primaryTileId: 'tile-01',
    relatedTileIds: ['tile-10'],
    docsUrl: 'https://www.onorca.dev/docs/model/worktrees'
  },
  {
    id: 'tasks',
    title: 'Tasks',
    meta: 'GitHub · Linear',
    lede: 'Find connected GitHub or Linear work in Tasks, then start from the item that needs attention.',
    bullets: [
      'Browse connected issues, PRs, and tasks from one in-app view.',
      'Open comments, status, and review context without switching tools.',
      'Start a workspace from the task when you are ready to build.'
    ],
    primaryTileId: 'tile-03',
    relatedTileIds: [],
    docsUrl: 'https://www.onorca.dev/docs/review/linear'
  },
  {
    id: 'agents-orchestration',
    title: 'Agents',
    meta: 'Agents · Usage · Orca CLI',
    lede: 'Run several agents at once, track their progress, and let automation drive Orca when it helps.',
    bullets: [
      'Preconfigured for Claude Code, Codex, Cursor CLI, Gemini, Copilot, OpenCode, and Pi.',
      'See live usage and rate-limit resets in the titlebar.',
      'Use Orca CLI automation for workspace creation and browser actions.'
    ],
    primaryTileId: 'tile-04',
    relatedTileIds: ['tile-11', 'tile-09'],
    docsUrl: 'https://www.onorca.dev/docs/agents/supported'
  },
  {
    id: 'workbench',
    title: 'Workbench',
    meta: 'Terminal · Editor · Browser · Files',
    lede: 'A fast configurable terminal — tabs, splits, and your own profile in every workspace.',
    bullets: [
      {
        leadIn: 'Splits, by keystroke or right-click.',
        body: '⌘D splits right, ⌘⇧D splits down — keep one workspace, run several things at once.'
      },
      {
        leadIn: 'Configurable.',
        body: 'Bring your own profile — fonts, theme, shell — same setup in every workspace.'
      }
    ],
    primaryTileId: 'tile-02',
    relatedTileIds: ['tile-07', 'tile-05', 'tile-12'],
    docsUrl: 'https://www.onorca.dev/docs/terminal'
  },
  {
    id: 'review',
    title: 'Code Review',
    meta: 'Diffs · Comments · PRs',
    lede: 'Review what changed, leave focused feedback, and send it back to the agent.',
    bullets: [
      'Comment directly on changed lines.',
      'Batch feedback and send it back to the agent.',
      'Open PRs, inspect CI, and move the change toward merge.'
    ],
    primaryTileId: 'tile-08',
    relatedTileIds: [],
    docsUrl: 'https://www.onorca.dev/docs/review/annotate-ai-diff'
  }
] as const

export const FEATURE_WALL_WORKFLOW_IDS = FEATURE_WALL_WORKFLOWS.map(
  (w) => w.id
) as readonly FeatureWallWorkflowId[]

const TILE_BY_ID = new Map(
  FEATURE_WALL_TILES.filter(isFeatureWallMediaTile).map((tile) => [tile.id, tile])
)

export function getFeatureWallMediaTile(id: FeatureWallMediaTileId): FeatureWallMediaTile | null {
  return TILE_BY_ID.get(id) ?? null
}

export function getFeatureWallWorkflow(id: FeatureWallWorkflowId): FeatureWallWorkflow | null {
  return FEATURE_WALL_WORKFLOWS.find((w) => w.id === id) ?? null
}

export const DEFAULT_FEATURE_WALL_WORKFLOW_ID: FeatureWallWorkflowId = 'workspaces'
