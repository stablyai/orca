import { ChevronRight } from 'lucide-react'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../../../../../../shared/orca-yaml-hook-types'
import { Trans } from 'react-i18next'
import { i18n, translate } from '@/i18n/i18n'
import { useTranslate, type Translate } from '@/i18n/use-translate'
import { matchesSettingsSearch } from '../../search/settings-search'
import { Switch } from '@/components/ui/switch'
import { RepositoryHooksYamlStatus } from './RepositoryHooksYamlStatus'

type PolicyOption<Policy> = { policy: Policy; label: string; description: string }

function SegmentedPolicyToggle<Policy extends string>({
  options,
  selected,
  onSelect
}: {
  options: PolicyOption<Policy>[]
  selected: Policy
  onSelect: (policy: Policy) => void
}): React.JSX.Element {
  return (
    <div className="inline-flex gap-0.5 rounded-lg border border-border/60 bg-muted/50 p-0.5">
      {options.map(({ policy, label, description }) => (
        <button
          type="button"
          key={policy}
          onClick={() => onSelect(policy)}
          title={description}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${selected === policy ? 'bg-primary text-primary-foreground shadow-sm' : 'text-muted-foreground hover:bg-background/60 hover:text-foreground'}`}
        >
          {label}
        </button>
      ))}
    </div>
  )
}

function getSetupRunPolicyOptions(t: Translate = translate): PolicyOption<SetupRunPolicy>[] {
  return [
    {
      policy: 'ask',
      label: t('auto.components.settings.RepositoryHooksSection.e03d9a8f38', 'Ask every time'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.90b1f50137',
        'Prompt before running setup.'
      )
    },
    {
      policy: 'run-by-default',
      label: t('auto.components.settings.RepositoryHooksSection.d3ef1ab247', 'Run by default'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.022ba10cf2',
        'Run setup automatically.'
      )
    },
    {
      policy: 'skip-by-default',
      label: t('auto.components.settings.RepositoryHooksSection.15debc1fd9', 'Skip by default'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.99e3264a49',
        'Only run setup when chosen.'
      )
    }
  ]
}

function getCommandSourcePolicyOptions(
  t: Translate = translate
): PolicyOption<HookCommandSourcePolicy>[] {
  return [
    {
      policy: 'shared-only',
      label: t('auto.components.settings.RepositoryHooksSection.d88b6ff88f', 'orca.yaml only'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.29397e8bbc',
        'Run only committed repo commands; ignore local commands.'
      )
    },
    {
      policy: 'local-only',
      label: t('auto.components.settings.RepositoryHooksSection.83dc78202a', 'Local only'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.0e8b2a520d',
        'Ignore orca.yaml; run only your local commands.'
      )
    },
    {
      policy: 'run-both',
      label: t('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.8561b0665f',
        'orca.yaml first, then your local commands.'
      )
    }
  ]
}

export function RepositorySetupRunPolicySetting({
  isFolder = false,
  setupRunPolicy,
  onRunPolicyChange
}: {
  isFolder?: boolean
  setupRunPolicy: SetupRunPolicy
  onRunPolicyChange: (policy: SetupRunPolicy) => void
}): React.JSX.Element {
  const t = useTranslate()
  return (
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0">
        <h5 className="text-sm font-semibold">
          {t('auto.components.settings.RepositoryHooksSection.793dcee97d', 'When to run')}
        </h5>
        <p className="text-xs text-muted-foreground">
          {isFolder
            ? t(
                'components.settings.RepositoryHooksSection.folderRunPolicyDescription',
                'Default behavior when a new workspace is created.'
              )
            : t(
                'auto.components.settings.RepositoryHooksSection.21fb607a87',
                'Default behavior when a new worktree is created.'
              )}
        </p>
      </div>
      <SegmentedPolicyToggle
        options={getSetupRunPolicyOptions(t)}
        selected={setupRunPolicy}
        onSelect={onRunPolicyChange}
      />
    </div>
  )
}

export function RepositorySetupAgentStartupSetting({
  setupAgentStartupPolicy,
  onStartupPolicyChange
}: {
  setupAgentStartupPolicy: SetupAgentStartupPolicy
  onStartupPolicyChange: (policy: SetupAgentStartupPolicy) => void
}): React.JSX.Element {
  const t = useTranslate()
  const label = t(
    'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgent',
    'Wait for setup to complete before starting agent'
  )
  return (
    <div className="flex items-center justify-between gap-4">
      <h5 className="min-w-0 text-sm font-semibold">{label}</h5>
      <Switch
        checked={setupAgentStartupPolicy === 'wait-for-setup'}
        onCheckedChange={(checked) =>
          onStartupPolicyChange(checked ? 'wait-for-setup' : 'start-immediately')
        }
        aria-label={label}
      />
    </div>
  )
}

function getCommandSourceLabel(policy: HookCommandSourcePolicy, t: Translate = translate): string {
  if (policy === 'shared-only') {
    return t('auto.components.settings.RepositoryHooksSection.d88b6ff88f', 'orca.yaml only')
  }
  if (policy === 'local-only') {
    return t('auto.components.settings.RepositoryHooksSection.83dc78202a', 'Local only')
  }
  return t('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both')
}

export function RepositoryHookCommandSourceSetting({
  searchQuery,
  selectedPolicy,
  setupOnly = false,
  yamlState,
  yamlHooks,
  copiedTemplate,
  isAdvancedOpen,
  onSelectPolicy,
  onCopyTemplate,
  onAdvancedOpenChange
}: {
  searchQuery: string
  selectedPolicy: HookCommandSourcePolicy
  setupOnly?: boolean
  yamlState: string
  yamlHooks: OrcaHooks | null
  copiedTemplate: boolean
  isAdvancedOpen: boolean
  onSelectPolicy: (policy: HookCommandSourcePolicy) => void
  onCopyTemplate: () => void
  onAdvancedOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const advancedMatchesSearch =
    searchQuery.trim() !== '' &&
    matchesSettingsSearch(searchQuery, {
      title: t('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced'),
      description: t(
        'auto.components.settings.RepositoryHooksSection.610d90fdbd',
        'Command source and orca.yaml details.'
      ),
      keywords: [
        t('auto.components.settings.RepositoryHooksSection.c5a55a2d2e', 'advanced'),
        t('auto.components.settings.RepositoryHooksSection.4611b78617', 'command source'),
        t('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml'),
        t('auto.components.settings.RepositoryHooksSection.d2b3016c20', 'shared'),
        t('auto.components.settings.RepositoryHooksSection.2d03a514db', 'local'),
        t('auto.components.settings.RepositoryHooksSection.0518758f38', 'both'),
        t('auto.components.settings.RepositoryHooksSection.fac13f8c1e', 'authoritative')
      ]
    })
  const options = getCommandSourcePolicyOptions(t)
  return (
    <details
      className="group"
      open={advancedMatchesSearch || isAdvancedOpen}
      onToggle={(event) => {
        if (advancedMatchesSearch) {
          event.currentTarget.open = true
        } else {
          onAdvancedOpenChange(event.currentTarget.open)
        }
      }}
    >
      <summary
        className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-md outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          if (advancedMatchesSearch) {
            event.preventDefault()
          }
        }}
      >
        <div className="flex items-center gap-2">
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
          <h5 className="text-sm font-semibold">
            {t('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced')}
          </h5>
          <span className="text-xs text-muted-foreground">
            {t(
              'auto.components.settings.RepositoryHooksSection.bbbd6e0bc4',
              'Command source & orca.yaml'
            )}
          </span>
        </div>
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
          {getCommandSourceLabel(selectedPolicy, t)}
        </span>
      </summary>
      <div className="space-y-5 pt-4 pl-5.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {t('auto.components.settings.RepositoryHooksSection.88c6d1e54a', 'Command source')}
            </p>
            <p className="text-[11px] text-muted-foreground">
              <Trans
                i18n={i18n}
                defaults={t(
                  'auto.components.settings.RepositoryHooksSection.commandSourceDescription',
                  'When both <yaml>orca.yaml</yaml> and local commands exist, choose which run.'
                )}
                components={{ yaml: <code className="rounded bg-muted px-1 py-0.5" /> }}
              />
            </p>
          </div>
          <div className="space-y-1.5">
            <SegmentedPolicyToggle
              options={options}
              selected={selectedPolicy}
              onSelect={onSelectPolicy}
            />
            <p className="text-right text-[11px] text-muted-foreground">
              {options.find((option) => option.policy === selectedPolicy)?.description}
            </p>
          </div>
        </div>
        <RepositoryHooksYamlStatus
          setupOnly={setupOnly}
          yamlState={yamlState}
          yamlHooks={yamlHooks}
          copiedTemplate={copiedTemplate}
          onCopyTemplate={onCopyTemplate}
        />
      </div>
    </details>
  )
}
