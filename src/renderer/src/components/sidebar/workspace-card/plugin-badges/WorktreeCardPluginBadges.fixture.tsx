import { getDefaultSettings } from '../../../../../../shared/constants'
import type { PluginHostListEntry } from '../../../../../../shared/plugins/plugin-list-entry'
import { usePluginPanelsStore } from '@/store/plugins/catalog/plugin-contribution-catalog'
import { defineFixture } from '../../../../component-fixtures/component-fixture'
import { makeRepo, makeWorktree } from '../../../worktree-jump/worktree-jump-palette-test-fixtures'
import WorktreeCard from '../surface/WorktreeCard'

const CUBE =
  '<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path d="M12 2 3 7v10l9 5 9-5V7z"/></svg>'

const enginePlugin: PluginHostListEntry = {
  pluginKey: 'fixture.engine',
  consentFingerprint: 'fixture',
  name: 'Engine',
  version: '1.0.0',
  publisher: 'fixture',
  status: 'idle',
  needsReconsent: false,
  isDev: false,
  official: false,
  bundled: false,
  capabilities: [],
  panels: [],
  commands: [
    {
      id: 'open-project',
      title: 'Open in Engine',
      context: 'workspace',
      handler: { type: 'worker' },
      keybindings: []
    }
  ],
  worktreeBadges: [
    {
      id: 'engine-project',
      title: 'Engine project',
      icon: { kind: 'svg', markup: CUBE },
      when: { pathExists: ['engine.project'], searchDepth: 2, host: 'local' },
      commands: ['open-project']
    }
  ],
  hasWorker: true,
  restarts: 0
}

const repo = { ...makeRepo(), displayName: 'starfall-racer' }
const game = makeWorktree('badge-fixture-game', 'feat/drift-physics', {
  path: '/work/starfall-racer',
  branch: 'refs/heads/feat/drift-physics'
})
const web = makeWorktree('badge-fixture-web', 'feat/leaderboard-page', {
  path: '/work/leaderboard-web',
  branch: 'refs/heads/feat/leaderboard-page'
})
const MARKERS = new Set([
  '/work/starfall-racer/Game/engine.project',
  '/work/starfall-racer/Tools/LevelEditor/engine.project'
])
const FOLDERS: Record<string, string[]> = {
  '/work/starfall-racer': ['Game', 'Tools', 'Docs'],
  '/work/starfall-racer/Tools': ['LevelEditor']
}

function installPlugin(enabled: boolean): void {
  usePluginPanelsStore.getState().setPlugins(enabled ? [enginePlugin] : [])
  Object.assign(window.api.fs, {
    pathExists: async ({ filePath }: { filePath: string }) => MARKERS.has(filePath),
    pathsExist: async ({ filePaths }: { filePaths: string[] }) =>
      filePaths.map((filePath) => ({ exists: MARKERS.has(filePath) })),
    readDir: async ({ dirPath }: { dirPath: string }) =>
      (FOLDERS[dirPath] ?? []).map((name) => ({ name, isDirectory: true, isSymlink: false }))
  })
}

const store = {
  settings: { ...getDefaultSettings('/home/fixture'), experimentalNewWorktreeCardStyle: true },
  repos: [repo],
  worktreesByRepo: { [repo.id]: [game, web] },
  worktreeCardProperties: ['status' as const, 'branch' as const]
}

function Cards(): React.JSX.Element {
  return (
    <div className="flex flex-col gap-1 bg-worktree-sidebar p-2 pb-24 text-worktree-sidebar-foreground">
      <WorktreeCard worktree={game} repo={repo} isActive nativeDragEnabled={false} />
      <WorktreeCard worktree={web} repo={repo} isActive={false} nativeDragEnabled={false} />
    </div>
  )
}

async function waitForBadge(frame: HTMLElement): Promise<HTMLElement> {
  for (let attempt = 0; attempt < 40; attempt++) {
    const badge = frame.querySelector<HTMLElement>('[data-worktree-card-plugin-badge]')
    if (badge) {
      return badge
    }
    await new Promise((resolve) => setTimeout(resolve, 50))
  }
  throw new Error('The engine badge should appear on the workspace holding engine projects')
}

/** Before: the same workspaces with no plugin contributing a badge. */
export const withoutPlugin = defineFixture({
  width: 320,
  store,
  setup: () => installPlugin(false),
  render: () => <Cards />
})

/** After: the badge marks only the workspace holding projects, and lists each project folder. */
export const menuOpen = defineFixture({
  width: 320,
  store,
  setup: () => installPlugin(true),
  render: () => <Cards />,
  interact: async (frame) => {
    const badge = await waitForBadge(frame)
    badge.focus()
    badge.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter' }))
    await new Promise((resolve) => setTimeout(resolve, 300))
    // Why: focusing the badge also opens the card's details hover card, which hides the menu.
    document
      .querySelector('[data-worktree-hover-identity-header]')
      ?.closest<HTMLElement>('[data-radix-popper-content-wrapper]')
      ?.style.setProperty('display', 'none')
  }
})
