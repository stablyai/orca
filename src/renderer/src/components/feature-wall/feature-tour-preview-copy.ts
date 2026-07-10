import { translate } from '@/i18n/i18n'

type FrameId = 1 | 2 | 3 | 4

export type FeatureTourPreviewFrameCopy = {
  id: FrameId
  title: string
  caption: string
}

export const FEATURE_TOUR_PREVIEW_COPY: readonly FeatureTourPreviewFrameCopy[] = [
  {
    id: 1,
    get title() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.56a0271428',
        'Isolated workspaces'
      )
    },
    get caption() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.47f16ecf34',
        'Ship several things at once. Each workspace keeps its branch, terminal, and agent activity together.'
      )
    }
  },
  {
    id: 2,
    get title() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.e44269e97d',
        'Agent orchestration'
      )
    },
    get caption() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.70aa182266',
        'Hand off a goal and walk away. A coordinator agent fans out and ships parallel PRs.'
      )
    }
  },
  {
    id: 3,
    get title() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.ef737dcee1',
        'GitHub & Linear tasks'
      )
    },
    get caption() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.f10c14dd9d',
        'Skip the tab-switching. Pick from your GitHub or Linear backlog and start a workspace in one click.'
      )
    }
  },
  {
    id: 4,
    get title() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.1aa8a9a24a',
        'Splittable terminal'
      )
    },
    get caption() {
      return translate(
        'auto.components.feature.wall.FeatureTourPreview.5d6ee181b6',
        'Open any workspace to return to its terminal, then split panes for tests, logs, and agents.'
      )
    }
  }
]

export type FeatureTourOrchestrationChildAgent = 'claude' | 'codex' | 'opencode-go'

export const FEATURE_TOUR_ORCHESTRATION_CHILDREN: readonly {
  key: 'top' | 'mid' | 'bot'
  position: string
  label: string
  agent: FeatureTourOrchestrationChildAgent
}[] = [
  // Why: card vertical centers anchor to 18% / 50% / 82% — the same Y
  // endpoints the dashed SVG paths terminate at — so the connectors land on
  // each card's center regardless of card height.
  {
    key: 'top',
    position: 'top-[18%] -translate-y-1/2',
    get label() {
      return translate('auto.components.feature.wall.FeatureTourPreview.b1f17bcc74', 'PR 1/3')
    },
    agent: 'claude'
  },
  {
    key: 'mid',
    position: 'top-1/2 -translate-y-1/2',
    get label() {
      return translate('auto.components.feature.wall.FeatureTourPreview.cfdfd4d6b4', 'PR 2/3')
    },
    agent: 'codex'
  },
  {
    key: 'bot',
    position: 'top-[82%] -translate-y-1/2',
    get label() {
      return translate('auto.components.feature.wall.FeatureTourPreview.ec4a73f5e6', 'PR 3/3')
    },
    agent: 'opencode-go'
  }
]
