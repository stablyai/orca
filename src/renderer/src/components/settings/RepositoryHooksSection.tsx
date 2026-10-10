import { useMemo, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  RepoHookSettings,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../../../../shared/orca-yaml-hook-types'
import type { Repo } from '../../../../shared/repo-types'
import { getRepoExecutionHostId, parseExecutionHostId } from '../../../../shared/execution-host'
import { resolveHookCommandSourcePolicy } from '../../../../shared/hook-command-source-policy'
import { useAppStore } from '@/store'
import { translate } from '@/i18n/i18n'
import { SearchableSetting } from './SearchableSetting'
import { getRepositoryLocalCommandsSectionId } from './repository-settings-targets'
import {
  getLocalHookFields,
  getLocalCommandSourcePolicyNotice,
  type LocalCommandSourcePolicyNotice
} from './repository-hook-settings-draft'
import {
  LocalCommandSourceNotice,
  RepositoryHookScriptSetting
} from './RepositoryHookScriptSetting'
import {
  RepositoryHookCommandSourceSetting,
  RepositorySetupPolicySetting
} from './RepositoryHookPolicySettings'
import { RepositoryIssueCommandSetting } from './RepositoryIssueCommandSetting'
import { useRepositoryHookSettingsDraft } from './use-repository-hook-settings-draft'
import { useRepositoryIssueCommand } from './use-repository-issue-command'

export { getLocalCommandSourcePolicyNotice }
export type { LocalCommandSourcePolicyNotice }

type RepositoryHooksSectionProps = {
  repo: Repo
  yamlHooks: OrcaHooks | null
  hasHooksFile: boolean
  hooksInspectionReady: boolean
  mayNeedUpdate: boolean
  copiedTemplate: boolean
  forceVisible?: boolean
  onCopyTemplate: () => void
  onUpdateHookSettings: (settings: RepoHookSettings) => void
}

export function RepositoryHooksSection({
  repo,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  copiedTemplate,
  forceVisible = false,
  onCopyTemplate,
  onUpdateHookSettings
}: RepositoryHooksSectionProps): React.JSX.Element {
  useTranslation()
  const settingsSearchQuery = useAppStore((state) => state.settingsSearchQuery)
  const selectedHostId = getRepoExecutionHostId(repo)
  const repoHostIdentity = `${selectedHostId}\0${repo.id}`
  const hookRuntimeSettings = useMemo(() => {
    const parsedHost = parseExecutionHostId(selectedHostId)
    return {
      activeRuntimeEnvironmentId: parsedHost?.kind === 'runtime' ? parsedHost.environmentId : null
    }
  }, [selectedHostId])
  const yamlState = yamlHooks
    ? 'loaded'
    : hasHooksFile
      ? mayNeedUpdate
        ? 'update-available'
        : 'invalid'
      : 'missing'
  const {
    hookSettingsDraft,
    updateScriptDraft,
    commitScriptDraft,
    flushScriptDraftOnUnmount,
    updateHookSettingsPolicyDraft
  } = useRepositoryHookSettingsDraft({ repo, repoHostIdentity, onUpdateHookSettings })
  const issueCommand = useRepositoryIssueCommand({
    hookRuntimeSettings,
    repoId: repo.id,
    repoHostIdentity,
    selectedHostId
  })
  const localHookFields = getLocalHookFields()
  const selectedSetupRunPolicy: SetupRunPolicy =
    hookSettingsDraft.setupRunPolicy ?? 'run-by-default'
  const selectedSetupAgentStartupPolicy: SetupAgentStartupPolicy =
    hookSettingsDraft.setupAgentStartupPolicy ?? 'start-immediately'
  const sharedSetupScript = yamlHooks?.scripts.setup
  const sharedArchiveScript = yamlHooks?.scripts.archive
  const hasSharedSetupScript = Boolean(sharedSetupScript?.trim())
  const hasSharedArchiveScript = Boolean(sharedArchiveScript?.trim())
  const hasSharedScript = hasSharedSetupScript || hasSharedArchiveScript
  const hasLocalScript = Boolean(
    hookSettingsDraft.scripts.setup?.trim() || hookSettingsDraft.scripts.archive?.trim()
  )
  const selectedCommandSourcePolicy: HookCommandSourcePolicy = resolveHookCommandSourcePolicy(
    hookSettingsDraft.commandSourcePolicy,
    { hasLocalScript }
  )
  const localCommandSourceNotice = getLocalCommandSourcePolicyNotice({
    hooksInspectionReady,
    currentPolicy: selectedCommandSourcePolicy,
    setupScript: hookSettingsDraft.scripts.setup,
    archiveScript: hookSettingsDraft.scripts.archive,
    hasSharedScript
  })
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

  return (
    <section ref={flushScriptDraftOnUnmount} className="space-y-6">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold">
          {translate(
            'auto.components.settings.RepositoryHooksSection.ff082fe7c6',
            'Worktree Hooks'
          )}
        </h2>
        <p className="text-xs text-muted-foreground">
          {translate(
            'auto.components.settings.RepositoryHooksSection.8567127a40',
            'Scripts that run when worktrees are created or archived. Local scripts are stored on this machine; `orca.yaml` scripts are shared with your team.'
          )}
        </p>
      </div>
      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.52b31baf02',
          'Setup Script'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.30d555acd2',
          'Local and shared scripts that run after a new worktree is created.'
        )}
        forceVisible={forceVisible}
        keywords={[
          'setup',
          'script',
          'command',
          'local',
          'local settings scripts',
          'orca.yaml',
          'orca.yaml hooks',
          'hook'
        ]}
      >
        <RepositoryHookScriptSetting
          key={`${repo.id}:setup`}
          field={localHookFields[0]}
          value={hookSettingsDraft.scripts.setup ?? ''}
          hasShared={hasSharedSetupScript}
          sharedScript={sharedSetupScript}
          onChange={(next) => updateScriptDraft('setup', next)}
          onCommit={commitScriptDraft}
          sectionId={getRepositoryLocalCommandsSectionId(repo.id)}
        />
      </SearchableSetting>
      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.fb6bebcf7e',
          'When to Run Setup'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.63e1783173',
          'Choose the default behavior when a setup script is available.'
        )}
        forceVisible={forceVisible}
        keywords={['setup run policy', 'ask', 'run by default', 'skip by default']}
      >
        <RepositorySetupPolicySetting
          setupRunPolicy={selectedSetupRunPolicy}
          setupAgentStartupPolicy={selectedSetupAgentStartupPolicy}
          onRunPolicyChange={(setupRunPolicy) => updateHookSettingsPolicyDraft({ setupRunPolicy })}
          onStartupPolicyChange={(setupAgentStartupPolicy) =>
            updateHookSettingsPolicyDraft({ setupAgentStartupPolicy })
          }
        />
      </SearchableSetting>
      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.9a100323ff',
          'Archive Script'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.b91a0f297d',
          'Local and shared scripts that run before a worktree is archived.'
        )}
        forceVisible={forceVisible}
        keywords={[
          'archive',
          'script',
          'command',
          'local',
          'local settings scripts',
          'orca.yaml',
          'orca.yaml hooks',
          'hook'
        ]}
      >
        <RepositoryHookScriptSetting
          key={`${repo.id}:archive`}
          field={localHookFields[1]}
          value={hookSettingsDraft.scripts.archive ?? ''}
          hasShared={hasSharedArchiveScript}
          sharedScript={sharedArchiveScript}
          onChange={(next) => updateScriptDraft('archive', next)}
          onCommit={commitScriptDraft}
        />
      </SearchableSetting>
      {localCommandSourceNotice ? (
        <LocalCommandSourceNotice
          notice={localCommandSourceNotice}
          onSelectPolicy={(commandSourcePolicy) =>
            updateHookSettingsPolicyDraft({ commandSourcePolicy })
          }
        />
      ) : null}
      <SearchableSetting
        title={translate(
          'auto.components.settings.RepositoryHooksSection.13394103bd',
          'Custom GitHub Issue Command'
        )}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.2cc27dc12b',
          'Optional per-user override for the linked-issue command.'
        )}
        forceVisible={forceVisible}
        keywords={['github issue command', 'issue command', 'workflow', 'agent', 'github']}
      >
        <RepositoryIssueCommandSetting {...issueCommand} />
      </SearchableSetting>
      <SearchableSetting
        title={translate('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced')}
        description={translate(
          'auto.components.settings.RepositoryHooksSection.610d90fdbd',
          'Command source and orca.yaml details.'
        )}
        forceVisible={forceVisible}
        keywords={[
          'advanced',
          'command source',
          'orca.yaml',
          'shared',
          'local',
          'both',
          'authoritative'
        ]}
      >
        <RepositoryHookCommandSourceSetting
          searchQuery={settingsSearchQuery}
          selectedPolicy={selectedCommandSourcePolicy}
          yamlState={yamlState}
          yamlHooks={yamlHooks}
          copiedTemplate={copiedTemplate}
          onSelectPolicy={(commandSourcePolicy) =>
            updateHookSettingsPolicyDraft({ commandSourcePolicy })
          }
          onCopyTemplate={onCopyTemplate}
          isAdvancedOpen={isAdvancedOpen}
          onAdvancedOpenChange={setIsAdvancedOpen}
        />
      </SearchableSetting>
    </section>
  )
}
