import type { AgentsStepId } from '../../../../shared/agents-orchestration-steps'
import type { FeatureWallMediaTileId } from '../../../../shared/feature-wall-tiles'
import type { FeatureWallWorkflowId } from '../../../../shared/feature-wall-workflows'
import type { ReviewStepId } from '../../../../shared/review-steps'
import type { WorkbenchStepId } from '../../../../shared/workbench-steps'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

type FeatureWallTourStepId = AgentsStepId | WorkbenchStepId | ReviewStepId

type LocalizedWorkflowCopy = { title: string; lede: string }
type LocalizedStepCopy = { name: string; subtitle: string; description: string }

// Shared tour data stays English for other clients; the desktop translates it by id.
const getWorkflowCopyById = createLocalizedCatalog(
  (): Record<FeatureWallWorkflowId, LocalizedWorkflowCopy> => ({
    workspaces: {
      title: translate('featureWall.workflows.workspaces.title', 'Workspaces'),
      lede: translate(
        'featureWall.workflows.workspaces.lede',
        'Orca splits each task into an isolated workspace so agents can run in parallel.'
      )
    },
    tasks: {
      title: translate('featureWall.workflows.tasks.title', 'Tasks'),
      lede: translate(
        'featureWall.workflows.tasks.lede',
        'Start work directly from GitHub or Linear.'
      )
    },
    'agents-orchestration': {
      title: translate('featureWall.workflows.agents.title', 'Agents'),
      lede: translate(
        'featureWall.workflows.agents.lede',
        'Run several agents at once, track their progress, and let automation drive Orca when it helps.'
      )
    },
    workbench: {
      title: translate('featureWall.workflows.workbench.title', 'Workbench'),
      lede: translate(
        'featureWall.workflows.workbench.lede',
        'Bring your terminal setup into Orca, then split panes to keep servers, tests, logs, and agents running side by side.'
      )
    },
    review: {
      title: translate('featureWall.workflows.review.title', 'Code Review'),
      lede: translate(
        'featureWall.workflows.review.lede',
        'Review what changed, leave focused feedback, and send it back to the agent.'
      )
    }
  })
)

const getStepCopyById = createLocalizedCatalog(
  (): Record<FeatureWallTourStepId, LocalizedStepCopy> => ({
    statuses: {
      name: translate('featureWall.steps.statuses.name', 'Visibility'),
      subtitle: translate('featureWall.steps.statuses.subtitle', 'Agent Visibility'),
      description: translate(
        'featureWall.steps.statuses.description',
        'Know which agents are working, waiting, live, or blocked.'
      )
    },
    orchestration: {
      name: translate('featureWall.steps.orchestration.name', 'Orchestration'),
      subtitle: translate('featureWall.steps.orchestration.name', 'Orchestration'),
      description: translate(
        'featureWall.steps.orchestration.description',
        'Enable agents to manage and coordinate Orca workspaces to execute larger tasks.'
      )
    },
    usage: {
      name: translate('featureWall.steps.usage.name', 'Usage'),
      subtitle: translate('featureWall.steps.usage.name', 'Usage'),
      description: translate(
        'featureWall.steps.usage.description',
        'Watch your usage and rate limits across every connected account, so you know when to switch.'
      )
    },
    terminal: {
      name: translate('featureWall.steps.terminal.name', 'Terminal'),
      subtitle: translate('featureWall.steps.terminal.name', 'Terminal'),
      description: translate(
        'featureWall.steps.terminal.description',
        'Keep your agents, tests, and dev logs visible at once.'
      )
    },
    editor: {
      name: translate('featureWall.steps.editor.name', 'Editor'),
      subtitle: translate('featureWall.steps.editor.name', 'Editor'),
      description: translate(
        'featureWall.steps.editor.description',
        'Use our Notion-style markdown editor to write notes without leaving Orca.'
      )
    },
    browser: {
      name: translate('featureWall.steps.browser.name', 'Browser'),
      subtitle: translate('featureWall.steps.browser.name', 'Browser'),
      description: translate(
        'featureWall.steps.browser.description',
        "Run your app in Orca's browser, send selected UI elements to agents, and let your agents interact with your webpage."
      )
    },
    notes: {
      name: translate('featureWall.steps.notes.name', 'Notes'),
      subtitle: translate('featureWall.steps.notes.subtitle', 'Notes & diffs'),
      description: translate(
        'featureWall.steps.notes.description',
        'Send focused review notes to an agent.'
      )
    },
    'pr-view': {
      name: translate('featureWall.steps.prView.name', 'PR checks'),
      subtitle: translate('featureWall.steps.prView.subtitle', 'PR checks & comments'),
      description: translate(
        'featureWall.steps.prView.description',
        'See PR status in the Checks tab.'
      )
    },
    ship: {
      name: translate('featureWall.steps.ship.name', 'Ship with AI'),
      subtitle: translate('featureWall.steps.ship.name', 'Ship with AI'),
      description: translate(
        'featureWall.steps.ship.description',
        'Let AI prepare commit and PR drafts for you.'
      )
    }
  })
)

const getTileTitleById = createLocalizedCatalog((): Record<FeatureWallMediaTileId, string> => ({
  'tile-01': translate('featureWall.tiles.tile01.title', 'Parallel workspace orchestration'),
  'tile-02': translate('featureWall.tiles.tile02.title', 'Ghostty-class terminal'),
  'tile-03': translate('featureWall.tiles.tile03.title', 'GitHub & Linear, native'),
  'tile-04': translate('featureWall.tiles.tile04.title', 'Supported CLI agents'),
  'tile-05': translate('featureWall.tiles.tile05.title', 'Embedded browser + Design Mode'),
  'tile-06': translate('featureWall.tiles.tile06.title', 'Remote workspaces'),
  'tile-07': translate('featureWall.tiles.tile07.title', 'Monaco editor, drag-to-agent'),
  'tile-08': translate('featureWall.tiles.tile08.title', 'Inline review, back to the agent'),
  'tile-09': translate('featureWall.tiles.tile09.title', 'Orca CLI'),
  'tile-10': translate('featureWall.tiles.tile10.title', 'Keyboard-native'),
  'tile-11': translate('featureWall.tiles.tile11.title', 'Usage & rate-limit aware'),
  'tile-12': translate('featureWall.tiles.tile12.title', 'PDFs, images, CSV, Markdown')
}))

export function getLocalizedFeatureWallWorkflowCopy(
  id: FeatureWallWorkflowId
): LocalizedWorkflowCopy {
  return getWorkflowCopyById()[id]
}

export function getLocalizedFeatureWallStepCopy(id: FeatureWallTourStepId): LocalizedStepCopy {
  return getStepCopyById()[id]
}

export function getLocalizedFeatureWallTileTitle(id: FeatureWallMediaTileId): string {
  return getTileTitleById()[id]
}
