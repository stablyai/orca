import type { FeatureTip, FeatureTipId } from '../../../../shared/feature-education/feature-tips'
import { translate } from '@/i18n/i18n'

const FEATURE_TIP_COPY: Record<
  FeatureTipId,
  {
    title: () => string
    description: () => string
    ctaLabel: () => string
  }
> = {
  'chat-ui-here': {
    title: () => translate('featureTips.chatUiHere.title', 'Chat UI is here'),
    description: () =>
      translate(
        'featureTips.chatUiHere.offIntro',
        'Agents can now open as a chat, with rich messages, visuals and images.'
      ),
    ctaLabel: () => translate('featureTips.chatUiHere.cta', 'Use Chat UI')
  },
  'bots-teammate': {
    title: () => translate('featureTips.botsTeammate.title', 'Your AI teammate'),
    description: () =>
      translate(
        'featureTips.botsTeammate.description',
        'Ask it in a thread. It runs the work, gets it reviewed and brings back a pull request.'
      ),
    ctaLabel: () => translate('featureTips.botsTeammate.cta', 'Create a bot')
  },
  'agent-session-search': {
    title: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.f98e9d1bad',
        'Search every agent session'
      ),
    description: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.990cc29865',
        'Find any past conversation by what was said in it, then pick up where the agent left off.'
      ),
    ctaLabel: () =>
      translate('auto.components.feature.tips.feature.tip.copy.91e2719807', 'Enable session search')
  },
  'orca-cli': {
    title: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.3eacedec93',
        'Let agents drive Orca with the Orca CLI'
      ),
    description: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.8d54d0ff53',
        'Enable agents to coordinate child worktrees and communicate between worktrees.'
      ),
    ctaLabel: () =>
      translate('auto.components.feature.tips.feature.tip.copy.0080bc86eb', 'Install CLI & Skills')
  },
  'cmd-j-palette': {
    // Keep "<shortcut>" so CmdJPaletteTipDialog can inline the live keybinding.
    title: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.9b58bc5d7a',
        'Jump to a worktree with <shortcut>'
      ),
    description: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.655fc3cb5a',
        'Search worktrees, switch tabs, tweak settings, or spin up a new worktree, all without leaving the keyboard.'
      ),
    ctaLabel: () => translate('auto.components.feature.tips.feature.tip.copy.eb5e9e90ec', 'Got it')
  },
  'voice-dictation': {
    title: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.5221facada',
        'Dictate into any pane'
      ),
    description: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.5d69275490',
        'Start voice dictation in any focused pane, then use the shortcut again to stop.'
      ),
    ctaLabel: () =>
      translate('auto.components.feature.tips.feature.tip.copy.24aaad376f', 'Set up dictation')
  }
}

/** Map shared English feature-tip catalog fields to the active UI locale. */
export function localizeFeatureTip(tip: FeatureTip): FeatureTip {
  const copy = FEATURE_TIP_COPY[tip.id]
  return {
    ...tip,
    title: copy.title(),
    description: copy.description(),
    ctaLabel: copy.ctaLabel()
  }
}
