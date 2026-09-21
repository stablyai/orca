import { ChevronRight } from 'lucide-react'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../../../../shared/orca-yaml-hook-types'
import { translate } from '@/i18n/i18n'
import { matchesSettingsSearch } from './settings-search'
import { SettingsSwitch } from './SettingsFormControls'
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

function getSetupRunPolicyOptions(): PolicyOption<SetupRunPolicy>[] {
  return [
    {
      policy: 'ask',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.e03d9a8f38',
        'Ask every time'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.90b1f50137',
        'Prompt before running setup.'
      )
    },
    {
      policy: 'run-by-default',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.d3ef1ab247',
        'Run by default'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.022ba10cf2',
        'Run setup automatically.'
      )
    },
    {
      policy: 'skip-by-default',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.15debc1fd9',
        'Skip by default'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.99e3264a49',
        'Only run setup when chosen.'
      )
    }
  ]
}

function getCommandSourcePolicyOptions(): PolicyOption<HookCommandSourcePolicy>[] {
  return [
    {
      policy: 'shared-only',
      label: translate(
        'auto.components.settings.RepositoryHooksSection.d88b6ff88f',
        'orca.yaml only'
      ),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.29397e8bbc',
        'Run only committed repo commands; ignore local commands.'
      )
    },
    {
      policy: 'local-only',
      label: translate('auto.components.settings.RepositoryHooksSection.83dc78202a', 'Local only'),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.0e8b2a520d',
        'Ignore orca.yaml; run only your local commands.'
      )
    },
    {
      policy: 'run-both',
      label: translate('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both'),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.8561b0665f',
        'orca.yaml first, then your local commands.'
      )
    }
  ]
}

export function RepositorySetupPolicySetting({
  setupRunPolicy,
  setupAgentStartupPolicy,
  onRunPolicyChange,
  onStartupPolicyChange
}: {
  setupRunPolicy: SetupRunPolicy
  setupAgentStartupPolicy: SetupAgentStartupPolicy
  onRunPolicyChange: (policy: SetupRunPolicy) => void
  onStartupPolicyChange: (policy: SetupAgentStartupPolicy) => void
}): React.JSX.Element {
  const options = getSetupRunPolicyOptions()
  return (
    <div className="space-y-4 rounded-2xl border border-border/50 bg-background/80 p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <h5 className="text-sm font-semibold">
            {translate('auto.components.settings.RepositoryHooksSection.793dcee97d', 'When to run')}
          </h5>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryHooksSection.21fb607a87',
              'Default behavior when a new worktree is created.'
            )}
          </p>
        </div>
        <SegmentedPolicyToggle
          options={options}
          selected={setupRunPolicy}
          onSelect={onRunPolicyChange}
        />
      </div>
      <div className="flex items-start justify-between gap-4 border-t border-border/60 pt-4">
        <div className="min-w-0 space-y-1">
          <h5 className="text-sm font-semibold">
            {translate(
              'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgent',
              'Wait for setup to complete before starting agent'
            )}
          </h5>
          <p className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgentHelp',
              'Turn this on when setup installs dependencies, MCP servers, or config files the agent needs during startup.'
            )}
          </p>
        </div>
        <SettingsSwitch
          checked={setupAgentStartupPolicy === 'wait-for-setup'}
          onChange={() =>
            onStartupPolicyChange(
              setupAgentStartupPolicy === 'wait-for-setup' ? 'start-immediately' : 'wait-for-setup'
            )
          }
          ariaLabel={translate(
            'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgent',
            'Wait for setup to complete before starting agent'
          )}
        />
      </div>
    </div>
  )
}

function getCommandSourceLabel(policy: HookCommandSourcePolicy): string {
  if (policy === 'shared-only') {
    return translate('auto.components.settings.RepositoryHooksSection.d88b6ff88f', 'orca.yaml only')
  }
  if (policy === 'local-only') {
    return translate('auto.components.settings.RepositoryHooksSection.83dc78202a', 'Local only')
  }
  return translate('auto.components.settings.RepositoryHooksSection.8d6c56bff8', 'Run both')
}

export function RepositoryHookCommandSourceSetting({
  searchQuery,
  selectedPolicy,
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
  yamlState: string
  yamlHooks: OrcaHooks | null
  copiedTemplate: boolean
  isAdvancedOpen: boolean
  onSelectPolicy: (policy: HookCommandSourcePolicy) => void
  onCopyTemplate: () => void
  onAdvancedOpenChange: (open: boolean) => void
}): React.JSX.Element {
  const advancedMatchesSearch =
    searchQuery.trim() !== '' &&
    matchesSettingsSearch(searchQuery, {
      title: translate('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced'),
      description: translate(
        'auto.components.settings.RepositoryHooksSection.610d90fdbd',
        'Command source and orca.yaml details.'
      ),
      keywords: [
        translate('auto.components.settings.RepositoryHooksSection.c5a55a2d2e', 'advanced'),
        translate('auto.components.settings.RepositoryHooksSection.4611b78617', 'command source'),
        translate('auto.components.settings.RepositoryHooksSection.39da2ae12f', 'orca.yaml'),
        translate('auto.components.settings.RepositoryHooksSection.d2b3016c20', 'shared'),
        translate('auto.components.settings.RepositoryHooksSection.2d03a514db', 'local'),
        translate('auto.components.settings.RepositoryHooksSection.0518758f38', 'both'),
        translate('auto.components.settings.RepositoryHooksSection.fac13f8c1e', 'authoritative')
      ]
    })
  const options = getCommandSourcePolicyOptions()
  return (
    <details
      className="group rounded-2xl border border-border/50 bg-background/80 shadow-sm"
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
        className="flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 [&::-webkit-details-marker]:hidden"
        onClick={(event) => {
          if (advancedMatchesSearch) {
            event.preventDefault()
          }
        }}
      >
        <div className="flex items-center gap-2">
          <ChevronRight className="size-3.5 text-muted-foreground transition-transform group-open:rotate-90" />
          <h5 className="text-sm font-semibold">
            {translate('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced')}
          </h5>
          <span className="text-xs text-muted-foreground">
            {translate(
              'auto.components.settings.RepositoryHooksSection.bbbd6e0bc4',
              'Command source & orca.yaml'
            )}
          </span>
        </div>
        <span className="rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-foreground">
          {getCommandSourceLabel(selectedPolicy)}
        </span>
      </summary>
      <div className="space-y-5 border-t border-border/50 px-4 py-4">
        <div className="space-y-3">
          <div className="space-y-1">
            <p className="text-sm font-medium">
              {translate(
                'auto.components.settings.RepositoryHooksSection.32fec28f5b',
                'Command Source'
              )}
            </p>
            <p className="text-[11px] text-muted-foreground">
              {translate('auto.components.settings.RepositoryHooksSection.ac9038d2cc', 'When both')}{' '}
              <code className="rounded bg-muted px-1 py-0.5">
                {translate(
                  'auto.components.settings.RepositoryHooksSection.39da2ae12f',
                  'orca.yaml'
                )}
              </code>{' '}
              {translate(
                'auto.components.settings.RepositoryHooksSection.3397879bee',
                'and local commands exist, choose which run.'
              )}
            </p>
          </div>
          <div className="grid gap-2 md:grid-cols-3">
            {options.map(({ policy, label, description }) => (
              <button
                type="button"
                key={policy}
                onClick={() => onSelectPolicy(policy)}
                className={`rounded-xl border px-3 py-2.5 text-center transition-colors ${selectedPolicy === policy ? 'border-foreground/15 bg-accent text-accent-foreground' : 'border-border/60 bg-background text-foreground hover:border-border hover:bg-muted/40'}`}
              >
                <span
                  className={`block text-sm ${selectedPolicy === policy ? 'font-semibold' : 'font-medium'}`}
                >
                  {label}
                </span>
                <p
                  className={`mt-1 text-[11px] leading-4 ${selectedPolicy === policy ? 'text-accent-foreground/80' : 'text-muted-foreground'}`}
                >
                  {description}
                </p>
              </button>
            ))}
          </div>
        </div>
        <RepositoryHooksYamlStatus
          yamlState={yamlState}
          yamlHooks={yamlHooks}
          copiedTemplate={copiedTemplate}
          onCopyTemplate={onCopyTemplate}
        />
      </div>
    </details>
  )
}
