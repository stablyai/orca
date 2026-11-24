import { FileCode2, ShieldCheck } from 'lucide-react'
import { Button } from '../ui/button'
import { Popover, PopoverContent, PopoverTrigger } from '../ui/popover'
import { useTranslate } from '@/i18n/use-translate'
import {
  createHarnessPolicyFromPreset,
  type HarnessCommitStyle,
  type HarnessPolicy,
  type HarnessPolicyPresetId,
  type HarnessRuleMode
} from '../../../../shared/harness/harness-policy'

const MODES: readonly HarnessRuleMode[] = ['block', 'warn', 'off']

export function HarnessPolicyPopover({
  policy,
  hasRepo,
  onChangePolicy,
  onEditYaml
}: {
  policy: HarnessPolicy
  hasRepo: boolean
  onChangePolicy: (next: HarnessPolicy) => void
  onEditYaml: () => void
}): React.JSX.Element {
  const t = useTranslate()

  const presetLabel =
    policy.preset === 'off'
      ? t('auto.components.workbench.harness.presetOff', 'Free')
      : policy.preset === 'standard'
        ? t('auto.components.workbench.harness.presetStandard', 'Standard')
        : policy.preset === 'google-cl'
          ? t('auto.components.workbench.harness.presetGoogleCl', 'Google CL')
          : t('auto.components.workbench.harness.presetCustom', 'Custom')

  const selectPreset = (preset: Exclude<HarnessPolicyPresetId, 'custom'>): void => {
    onChangePolicy(createHarnessPolicyFromPreset(preset))
  }

  const updateCommitMode = (mode: HarnessRuleMode): void => {
    onChangePolicy({
      ...policy,
      preset: 'custom',
      rules: {
        ...policy.rules,
        commitFormat: { ...policy.rules.commitFormat, mode }
      }
    })
  }

  const updateCommitStyle = (style: HarnessCommitStyle): void => {
    onChangePolicy({
      ...policy,
      preset: 'custom',
      rules: {
        ...policy.rules,
        commitFormat: { ...policy.rules.commitFormat, style }
      }
    })
  }

  const updateFeatureCommitMode = (mode: HarnessRuleMode): void => {
    onChangePolicy({
      ...policy,
      preset: 'custom',
      rules: { ...policy.rules, commitPerFeature: { mode } }
    })
  }

  const updateGateMode = (mode: HarnessRuleMode): void => {
    onChangePolicy({
      ...policy,
      preset: 'custom',
      rules: {
        ...policy.rules,
        preCommitGate: { ...policy.rules.preCommitGate, mode }
      }
    })
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button type="button" size="xs" variant="outline">
          <ShieldCheck className="size-3.5 text-primary" />
          <span>
            {t('auto.components.workbench.harness.triggerLabel', 'Harness: {{preset}}', {
              preset: presetLabel
            })}
          </span>
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-80">
        <div className="flex flex-col gap-3 p-3 text-xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-foreground">
              {t('auto.components.workbench.harness.title', 'Harness Policy')}
            </span>
            {hasRepo ? (
              <Button type="button" size="xs" variant="ghost" onClick={onEditYaml}>
                <FileCode2 className="size-3.5" />
                .orca/harness.yml
              </Button>
            ) : null}
          </div>

          <div className="flex flex-wrap gap-1.5">
            {(['off', 'standard', 'google-cl'] as const).map((preset) => (
              <Button
                key={preset}
                type="button"
                size="xs"
                variant={policy.preset === preset ? 'default' : 'outline'}
                onClick={() => selectPreset(preset)}
              >
                {preset === 'off'
                  ? t('auto.components.workbench.harness.presetOff', 'Free')
                  : preset === 'standard'
                    ? t('auto.components.workbench.harness.presetStandard', 'Standard')
                    : t('auto.components.workbench.harness.presetGoogleCl', 'Google CL')}
              </Button>
            ))}
          </div>

          <div className="flex flex-col gap-2 border-t border-border/60 pt-2">
            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t('auto.components.workbench.harness.commitPerFeature', 'Commit per feature')}
              </span>
              <div className="flex gap-1">
                {MODES.map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="xs"
                    variant={policy.rules.commitPerFeature.mode === m ? 'secondary' : 'ghost'}
                    onClick={() => updateFeatureCommitMode(m)}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            </div>

            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t('auto.components.workbench.harness.commitStyle', 'Commit format')}
              </span>
              <div className="flex gap-1">
                {MODES.map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="xs"
                    variant={policy.rules.commitFormat.mode === m ? 'secondary' : 'ghost'}
                    onClick={() => updateCommitMode(m)}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            </div>

            {policy.rules.commitFormat.mode !== 'off' ? (
              <div className="flex flex-wrap gap-1 pl-2">
                {(['google-cl', 'conventional'] as const).map((style) => (
                  <Button
                    key={style}
                    type="button"
                    size="xs"
                    variant={policy.rules.commitFormat.style === style ? 'default' : 'outline'}
                    onClick={() => updateCommitStyle(style)}
                  >
                    {style}
                  </Button>
                ))}
              </div>
            ) : null}

            <div className="flex items-center justify-between gap-2">
              <span className="text-muted-foreground">
                {t('auto.components.workbench.harness.preCommitGate', 'Pre-commit gate')}
              </span>
              <div className="flex gap-1">
                {MODES.map((m) => (
                  <Button
                    key={m}
                    type="button"
                    size="xs"
                    variant={policy.rules.preCommitGate.mode === m ? 'secondary' : 'ghost'}
                    onClick={() => updateGateMode(m)}
                  >
                    {m}
                  </Button>
                ))}
              </div>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
