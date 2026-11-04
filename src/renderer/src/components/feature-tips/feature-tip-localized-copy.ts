import type { FeatureTip, FeatureTipId } from '../../../../shared/feature-tips'
import { translate } from '@/i18n/i18n'
import { createLocalizedCatalog } from '@/i18n/localized-catalog'

type FeatureTipCopy = Pick<FeatureTip, 'eyebrow' | 'title' | 'description' | 'ctaLabel'>

const getFeatureTipCopyById = createLocalizedCatalog(
  (): Partial<Record<FeatureTipId, FeatureTipCopy>> => ({
    // The Chat UI tip's dialog renders its own translated copy for each variant.
    'agent-session-search': {
      eyebrow: translate('featureTips.eyebrowNew', 'New'),
      title: translate('featureTips.sessionSearch.title', 'Search every agent session'),
      description: translate(
        'featureTips.sessionSearch.description',
        'Find any past conversation by what was said in it, then pick up where the agent left off.'
      ),
      ctaLabel: translate('featureTips.sessionSearch.cta', 'Turn on session search')
    },
    'orca-cli': {
      eyebrow: translate('featureTips.eyebrowTip', 'Tip'),
      title: translate('featureTips.orcaCli.title', 'Let agents drive Orca with the Orca CLI'),
      description: translate(
        'featureTips.orcaCli.description',
        'Enable agents to coordinate child worktrees and communicate between worktrees.'
      ),
      ctaLabel: translate('featureTips.orcaCli.cta', 'Install CLI & Skills')
    },
    'cmd-j-palette': {
      eyebrow: translate('featureTips.eyebrowTip', 'Tip'),
      // The dialog replaces <shortcut> with the live key binding.
      title: translate('featureTips.cmdJPalette.title', 'Jump to a worktree with <shortcut>'),
      description: translate(
        'featureTips.cmdJPalette.description',
        'Search worktrees, switch tabs, tweak settings, or spin up a new worktree, all without leaving the keyboard.'
      ),
      ctaLabel: translate('featureTips.gotIt', 'Got it')
    },
    'voice-dictation': {
      eyebrow: translate('featureTips.eyebrowTip', 'Tip'),
      title: translate('featureTips.voice.title', 'Dictate into any pane'),
      description: translate(
        'featureTips.voice.description',
        'Start voice dictation in any focused pane, then use the shortcut again to stop.'
      ),
      ctaLabel: translate('featureTips.voice.cta', 'Set up voice dictation')
    }
  })
)

/** Shared tip data stays English for other clients; unknown ids keep it. */
export function getLocalizedFeatureTipCopy(tip: FeatureTip): FeatureTipCopy {
  return getFeatureTipCopyById()[tip.id] ?? tip
}
