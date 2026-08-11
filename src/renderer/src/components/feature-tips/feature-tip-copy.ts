import type { FeatureTip, FeatureTipId } from '../../../../shared/feature-tips'
import { translate } from '@/i18n/i18n'

const FEATURE_TIP_COPY: Record<
  FeatureTipId,
  {
    eyebrow: () => string
    title: () => string
    description: () => string
    ctaLabel: () => string
  }
> = {
  'orca-cli': {
    eyebrow: () => translate('auto.components.feature.tips.feature.tip.copy.52e9e84809', 'Tip'),
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
    eyebrow: () => translate('auto.components.feature.tips.feature.tip.copy.52e9e84809', 'Tip'),
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
    eyebrow: () => translate('auto.components.feature.tips.feature.tip.copy.52e9e84809', 'Tip'),
    title: () =>
      translate('auto.components.feature.tips.feature.tip.copy.5221facada', 'Dictate into any pane'),
    description: () =>
      translate(
        'auto.components.feature.tips.feature.tip.copy.5d69275490',
        'Start voice dictation in any focused pane, then use the shortcut again to stop.'
      ),
    ctaLabel: () =>
      translate('auto.components.feature.tips.feature.tip.copy.24aaad376f', 'Set up voice dictation')
  }
}

/** Map shared English feature-tip catalog fields to the active UI locale. */
export function localizeFeatureTip(tip: FeatureTip): FeatureTip {
  const copy = FEATURE_TIP_COPY[tip.id]
  return {
    ...tip,
    eyebrow: copy.eyebrow(),
    title: copy.title(),
    description: copy.description(),
    ctaLabel: copy.ctaLabel()
  }
}
