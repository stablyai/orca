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
    eyebrow: () => translate('auto.components.feature.tips.copy.eyebrow', 'Tip'),
    title: () =>
      translate(
        'auto.components.feature.tips.copy.orcaCli.title',
        'Let agents drive Orca with the Orca CLI'
      ),
    description: () =>
      translate(
        'auto.components.feature.tips.copy.orcaCli.description',
        'Enable agents to coordinate child worktrees and communicate between worktrees.'
      ),
    ctaLabel: () =>
      translate('auto.components.feature.tips.copy.orcaCli.cta', 'Install CLI & Skills')
  },
  'cmd-j-palette': {
    eyebrow: () => translate('auto.components.feature.tips.copy.eyebrow', 'Tip'),
    // Keep "<shortcut>" so CmdJPaletteTipDialog can inline the live keybinding.
    title: () =>
      translate(
        'auto.components.feature.tips.copy.cmdJPalette.title',
        'Jump to a worktree with <shortcut>'
      ),
    description: () =>
      translate(
        'auto.components.feature.tips.copy.cmdJPalette.description',
        'Search worktrees, switch tabs, tweak settings, or spin up a new worktree, all without leaving the keyboard.'
      ),
    ctaLabel: () => translate('auto.components.feature.tips.copy.cmdJPalette.cta', 'Got it')
  },
  'voice-dictation': {
    eyebrow: () => translate('auto.components.feature.tips.copy.eyebrow', 'Tip'),
    title: () =>
      translate('auto.components.feature.tips.copy.voiceDictation.title', 'Dictate into any pane'),
    description: () =>
      translate(
        'auto.components.feature.tips.copy.voiceDictation.description',
        'Start voice dictation in any focused pane, then use the shortcut again to stop.'
      ),
    ctaLabel: () =>
      translate('auto.components.feature.tips.copy.voiceDictation.cta', 'Set up voice dictation')
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
