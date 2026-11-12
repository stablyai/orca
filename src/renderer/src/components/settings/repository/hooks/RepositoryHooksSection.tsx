import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type {
  HookCommandSourcePolicy,
  OrcaHooks,
  RepoHookSettings,
  SetupAgentStartupPolicy,
  SetupRunPolicy
} from '../../../../../../shared/orca-yaml-hook-types'
import type { WorkspaceHookOwner } from '../../../../../../shared/workspace-hook-owner'
import { Button } from '@/components/ui/button'
import type { Repo } from '../../../../../../shared/repo-types'
import { getRepoExecutionHostId } from '../../../../../../shared/execution-host'
import { isFolderRepo } from '../../../../../../shared/repo-kind'
import { resolveHookCommandSourcePolicy } from '../../../../../../shared/hook-command-source-policy'
import { useAppStore } from '@/store/index'
import { useTranslate } from '@/i18n/use-translate'
import { SearchableSetting } from '../../section-layout/SearchableSetting'
import { SettingsGroup } from '../../section-layout/SettingsGroup'
import { getRepositoryLocalCommandsSectionId } from '../repository-settings-targets'
import {
  getLocalHookFields,
  getLocalCommandSourcePolicyNotice
} from './repository-hook-settings-draft'
import {
  LocalCommandSourceNotice,
  RepositoryHookScriptSetting
} from './RepositoryHookScriptSetting'
import {
  RepositoryHookCommandSourceSetting,
  RepositorySetupAgentStartupSetting,
  RepositorySetupRunPolicySetting
} from './RepositoryHookPolicySettings'
import { RepositoryIssueCommandSetting } from './RepositoryIssueCommandSetting'
import { useRepositoryHookSettingsDraft } from './use-repository-hook-settings-draft'
import { useRepositoryIssueCommand } from './use-repository-issue-command'
import { getRepositoryHookScriptDescription } from './repository-git-hooks-search-entries'

type RepositoryHooksSectionProps = {
  repo: WorkspaceHookOwner
  gitRepo?: Repo
  setupExample?: string
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
  gitRepo,
  setupExample,
  yamlHooks,
  hasHooksFile,
  hooksInspectionReady,
  mayNeedUpdate,
  copiedTemplate,
  forceVisible = false,
  onCopyTemplate,
  onUpdateHookSettings
}: RepositoryHooksSectionProps): React.JSX.Element {
  const t = useTranslate()
  useTranslation()
  const settingsSearchQuery = useAppStore((state) => state.settingsSearchQuery)
  const selectedHostId = getRepoExecutionHostId(repo)
  const repoHostIdentity = `${selectedHostId}\0${repo.id}`
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
  const isFolder = isFolderRepo(repo)
  const localHookFields = getLocalHookFields(t, isFolder)
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
  const localCommandSourceNotice = getLocalCommandSourcePolicyNotice(
    {
      hooksInspectionReady,
      currentPolicy: selectedCommandSourcePolicy,
      setupScript: hookSettingsDraft.scripts.setup,
      archiveScript: hookSettingsDraft.scripts.archive,
      hasSharedScript
    },
    t
  )
  const [isAdvancedOpen, setIsAdvancedOpen] = useState(false)

  return (
    <div ref={flushScriptDraftOnUnmount}>
      <SettingsGroup
        title={
          isFolder
            ? t('components.settings.RepositoryHooksSection.folderTitle', 'Workspace hooks')
            : t('auto.components.settings.RepositoryHooksSection.01bdba296f', 'Worktree hooks')
        }
        description={
          isFolder
            ? t(
                'components.settings.RepositoryHooksSection.folderDescription',
                'Scripts that run in this folder when a workspace is created or removed. Every workspace shares the folder. Local scripts are stored on this machine; `orca.yaml` scripts are shared with your team.'
              )
            : t(
                'auto.components.settings.RepositoryHooksSection.8567127a40',
                'Scripts that run when worktrees are created or archived. Local scripts are stored on this machine; `orca.yaml` scripts are shared with your team.'
              )
        }
      >
        <SearchableSetting
          title={t('auto.components.settings.RepositoryHooksSection.1ecf0b115a', 'Setup script')}
          description={getRepositoryHookScriptDescription(repo, 'setup', t)}
          className="py-4"
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
          {setupExample ? (
            <div className="mt-3 space-y-2">
              <p className="text-settings-detail text-muted-foreground">
                {t(
                  'settings.groupHooks.example',
                  'Example: create a worktree in each repo (this machine only)'
                )}
              </p>
              <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs">
                <code>{setupExample}</code>
              </pre>
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    updateScriptDraft('setup', setupExample)
                    commitScriptDraft()
                  }}
                >
                  {t('settings.groupHooks.useExample', 'Use this example')}
                </Button>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void window.api.ui.writeClipboardText(setupExample)}
                >
                  {t('common.copy', 'Copy')}
                </Button>
              </div>
            </div>
          ) : null}
        </SearchableSetting>
        <SearchableSetting
          title={t(
            'auto.components.settings.RepositoryHooksSection.1c17e751c4',
            'When to run setup'
          )}
          description={t(
            'auto.components.settings.RepositoryHooksSection.63e1783173',
            'Choose the default behavior when a setup script is available.'
          )}
          className="py-4"
          forceVisible={forceVisible}
          keywords={['setup run policy', 'ask', 'run by default', 'skip by default']}
        >
          <RepositorySetupRunPolicySetting
            isFolder={isFolder}
            setupRunPolicy={selectedSetupRunPolicy}
            onRunPolicyChange={(setupRunPolicy) =>
              updateHookSettingsPolicyDraft({ setupRunPolicy })
            }
          />
        </SearchableSetting>
        <SearchableSetting
          title={t(
            'auto.components.settings.RepositoryHooksSection.waitForSetupBeforeAgent',
            'Wait for setup to complete before starting agent'
          )}
          className="py-4"
          forceVisible={forceVisible}
          keywords={[
            'wait for setup before starting agent',
            'wait for setup to complete before starting agent',
            'setup'
          ]}
        >
          <RepositorySetupAgentStartupSetting
            setupAgentStartupPolicy={selectedSetupAgentStartupPolicy}
            onStartupPolicyChange={(setupAgentStartupPolicy) =>
              updateHookSettingsPolicyDraft({ setupAgentStartupPolicy })
            }
          />
        </SearchableSetting>
        <SearchableSetting
          title={t('auto.components.settings.RepositoryHooksSection.bfdb1266ce', 'Archive script')}
          description={getRepositoryHookScriptDescription(repo, 'archive', t)}
          className="py-4"
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
          <div data-settings-row="" className="py-4">
            <LocalCommandSourceNotice
              notice={localCommandSourceNotice}
              onSelectPolicy={(commandSourcePolicy) =>
                updateHookSettingsPolicyDraft({ commandSourcePolicy })
              }
            />
          </div>
        ) : null}
        {gitRepo && !isFolder ? (
          <RepositoryIssueCommandRow
            repo={gitRepo}
            repoHostIdentity={repoHostIdentity}
            forceVisible={forceVisible}
          />
        ) : null}
        <SearchableSetting
          title={t('auto.components.settings.RepositoryHooksSection.c9bc1bfd8f', 'Advanced')}
          description={t(
            'auto.components.settings.RepositoryHooksSection.610d90fdbd',
            'Command source and orca.yaml details.'
          )}
          className="py-4"
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
      </SettingsGroup>
    </div>
  )
}

/** The issue command needs a GitHub repo, so only Git projects mount its file inspection. */
function RepositoryIssueCommandRow({
  repo,
  repoHostIdentity,
  forceVisible
}: {
  repo: Repo
  repoHostIdentity: string
  forceVisible: boolean
}): React.JSX.Element {
  const t = useTranslate()
  const issueCommand = useRepositoryIssueCommand({
    repoId: repo.id,
    repoHostIdentity,
    selectedHostId: getRepoExecutionHostId(repo)
  })
  return (
    <SearchableSetting
      title={t(
        'auto.components.settings.RepositoryHooksSection.da00f141c2',
        'Custom GitHub issue command'
      )}
      description={t(
        'auto.components.settings.RepositoryHooksSection.2cc27dc12b',
        'Optional per-user override for the linked-issue command.'
      )}
      className="py-4"
      forceVisible={forceVisible}
      keywords={['github issue command', 'issue command', 'workflow', 'agent', 'github']}
    >
      <RepositoryIssueCommandSetting {...issueCommand} />
    </SearchableSetting>
  )
}
