export type FeatureWallTileId =
  | 'tile-01'
  | 'tile-02'
  | 'tile-03'
  | 'tile-04'
  | 'tile-05'
  | 'tile-06'
  | 'tile-07'
  | 'tile-08'
  | 'tile-09'
  | 'tile-10'
  | 'tile-11'
  | 'tile-12'

type FeatureWallTileBase = {
  id: FeatureWallTileId
  title: string
  caption: string
  owner: string
  docsUrl: string
}

export type FeatureWallTile =
  | (FeatureWallTileBase & {
      kind: 'media'
      gifPath: string
      posterPath: string
      recordedAtPath: string
    })
  | (FeatureWallTileBase & {
      kind: 'agent-status-mockup'
    })

export const FEATURE_WALL_MEDIA_TILE_IDS = [
  'tile-01',
  'tile-02',
  'tile-03',
  'tile-04',
  'tile-05',
  'tile-06',
  'tile-07',
  'tile-08',
  'tile-09',
  'tile-10',
  'tile-11',
  'tile-12'
] as const satisfies readonly FeatureWallTileId[]

export type FeatureWallMediaTileId = (typeof FEATURE_WALL_MEDIA_TILE_IDS)[number]

export type FeatureWallMediaTile = Extract<FeatureWallTile, { kind: 'media' }>

export function isFeatureWallMediaTile(tile: FeatureWallTile): tile is FeatureWallMediaTile {
  return tile.kind === 'media'
}

export const FEATURE_WALL_TILES: readonly FeatureWallTile[] = [
  {
    id: 'tile-01',
    kind: 'media',
    title: 'Parallel worktree orchestration',
    caption:
      'Every task runs in its own isolated git worktree - no stashing, no branch juggling. Fan one prompt across 5 agents, compare, merge the winner.',
    gifPath: 'tile-01.gif',
    posterPath: 'tile-01.poster.jpg',
    recordedAtPath: 'tile-01.recorded-at.json',
    owner: 'worktree-orchestration',
    docsUrl: 'https://www.onorca.dev/docs/model/worktrees'
  },
  {
    id: 'tile-02',
    kind: 'media',
    title: 'Ghostty-class terminal',
    caption:
      'WebGL rendering, infinite splits, scrollback restored on restart, full scrollback search.',
    gifPath: 'tile-02.gif',
    posterPath: 'tile-02.poster.jpg',
    recordedAtPath: 'tile-02.recorded-at.json',
    owner: 'terminal',
    docsUrl: 'https://www.onorca.dev/docs/terminal'
  },
  {
    id: 'tile-03',
    kind: 'media',
    title: 'GitHub & Linear, native',
    caption:
      'Browse GitHub and Linear tasks in-app. Start worktrees, review PRs, and approve without switching context.',
    gifPath: 'tile-03.gif',
    posterPath: 'tile-03.poster.jpg',
    recordedAtPath: 'tile-03.recorded-at.json',
    owner: 'task-integrations',
    docsUrl: 'https://www.onorca.dev/docs/review/linear'
  },
  {
    id: 'tile-04',
    kind: 'media',
    title: 'Works with every CLI agent',
    caption:
      'Claude Code, Codex, Cursor CLI, Gemini, Copilot, OpenCode, Pi - preconfigured. Any other CLI agent drops right in.',
    gifPath: 'tile-04.gif',
    posterPath: 'tile-04.poster.jpg',
    recordedAtPath: 'tile-04.recorded-at.json',
    owner: 'agent-integrations',
    docsUrl: 'https://www.onorca.dev/docs/agents/supported'
  },
  {
    id: 'tile-05',
    kind: 'media',
    title: 'Embedded browser + Design Mode',
    caption:
      'A real Chromium window per worktree. Click any UI element to send its HTML, CSS, and a cropped screenshot into your agent.',
    gifPath: 'tile-05.gif',
    posterPath: 'tile-05.poster.jpg',
    recordedAtPath: 'tile-05.recorded-at.json',
    owner: 'browser-experience',
    docsUrl: 'https://www.onorca.dev/docs/browser/design-mode'
  },
  {
    id: 'tile-06',
    kind: 'media',
    title: 'Remote worktrees over SSH',
    caption:
      'Run agents on a beefy remote box with full file editing, git, and terminals. Auto-reconnect, port forwarding, passphrase caching.',
    gifPath: 'tile-06.gif',
    posterPath: 'tile-06.poster.jpg',
    recordedAtPath: 'tile-06.recorded-at.json',
    owner: 'ssh-workspaces',
    docsUrl: 'https://www.onorca.dev/docs/ssh'
  },
  {
    id: 'tile-07',
    kind: 'media',
    title: 'Monaco editor, drag-to-agent',
    caption:
      "VS Code's editor, autosave everywhere, quick-open with hidden files, drag-drop files or Finder images into an agent prompt.",
    gifPath: 'tile-07.gif',
    posterPath: 'tile-07.poster.jpg',
    recordedAtPath: 'tile-07.recorded-at.json',
    owner: 'editor',
    docsUrl: 'https://www.onorca.dev/docs/editing/file-explorer'
  },
  {
    id: 'tile-08',
    kind: 'media',
    title: 'Inline review, back to the agent',
    caption:
      'Drop markdown comments on any diff line, batch them, ship them back to the agent. Inspect CI, resolve conflicts, open PRs - all in-app.',
    gifPath: 'tile-08.gif',
    posterPath: 'tile-08.poster.jpg',
    recordedAtPath: 'tile-08.recorded-at.json',
    owner: 'diff-review',
    docsUrl: 'https://www.onorca.dev/docs/review/annotate-ai-diff'
  },
  {
    id: 'tile-09',
    kind: 'media',
    title: 'Orca CLI',
    caption: 'Agents drive Orca too: orca worktree create, snapshot, click, fill.',
    gifPath: 'tile-09.gif',
    posterPath: 'tile-09.poster.jpg',
    recordedAtPath: 'tile-09.recorded-at.json',
    owner: 'orca-cli',
    docsUrl: 'https://www.onorca.dev/docs/cli/overview'
  },
  {
    id: 'tile-10',
    kind: 'media',
    title: 'Keyboard-native',
    caption:
      'Jump across worktrees, open files, and remap every shortcut. Move at the speed of your fingers.',
    gifPath: 'tile-10.gif',
    posterPath: 'tile-10.poster.jpg',
    recordedAtPath: 'tile-10.recorded-at.json',
    owner: 'keyboard-ux',
    docsUrl: 'https://www.onorca.dev/docs/model/quick-open'
  },
  {
    id: 'tile-11',
    kind: 'media',
    title: 'Usage & rate-limit aware',
    caption:
      'See Claude and Codex usage, rate-limit resets, and hot-swap Codex accounts without re-logging in.',
    gifPath: 'tile-11.gif',
    posterPath: 'tile-11.poster.jpg',
    recordedAtPath: 'tile-11.recorded-at.json',
    owner: 'usage-rate-limits',
    docsUrl: 'https://www.onorca.dev/docs/agents/usage-tracking'
  },
  {
    id: 'tile-12',
    kind: 'media',
    title: 'PDFs, images, CSV, Markdown',
    caption:
      'Preview everything your repo carries: PDFs, image diff modes, CSV tables, wiki-linked Markdown with search.',
    gifPath: 'tile-12.gif',
    posterPath: 'tile-12.poster.jpg',
    recordedAtPath: 'tile-12.recorded-at.json',
    owner: 'file-preview',
    docsUrl: 'https://www.onorca.dev/docs/editing/viewers'
  }
] as const
