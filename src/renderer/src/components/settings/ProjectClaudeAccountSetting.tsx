import type {
  ClaudeManagedAccountSummary,
  Project,
  ProjectUpdateArgs
} from '../../../../shared/types'
import { normalizeProjectClaudeAccountPreference } from '../../../../shared/project-claude-account-preference'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { SettingsRow } from './SettingsFormControls'
import { translate } from '@/i18n/i18n'

const INHERIT_GLOBAL_VALUE = '__inherit-global__'

type ProjectClaudeAccountSettingProps = {
  project: Project
  accounts: ClaudeManagedAccountSummary[]
  updateProject: (
    projectId: string,
    updates: ProjectUpdateArgs['updates']
  ) => void | Promise<unknown>
}

export function ProjectClaudeAccountSetting({
  project,
  accounts,
  updateProject
}: ProjectClaudeAccountSettingProps): React.JSX.Element {
  const preference = normalizeProjectClaudeAccountPreference(project.claudeAccountPreference)
  const selectedValue = preference.kind === 'account' ? preference.accountId : INHERIT_GLOBAL_VALUE
  const danglingAccountId =
    preference.kind === 'account' &&
    !accounts.some((account) => account.id === preference.accountId)
      ? preference.accountId
      : null

  const selectedAccount = accounts.find((account) => account.id === selectedValue)
  const selectedLabel =
    preference.kind !== 'account'
      ? translate(
          'auto.components.settings.ProjectClaudeAccountSetting.defaultAccount',
          'Default (follow global account)'
        )
      : selectedAccount
        ? getClaudeAccountOptionLabel(selectedAccount)
        : translate(
            'auto.components.settings.ProjectClaudeAccountSetting.removedAccount',
            'Removed account'
          )

  const handleChange = (value: string): void => {
    if (value === INHERIT_GLOBAL_VALUE) {
      void updateProject(project.id, { claudeAccountPreference: { kind: 'inherit-global' } })
      return
    }
    void updateProject(project.id, {
      claudeAccountPreference: { kind: 'account', accountId: value }
    })
  }

  return (
    <section className="space-y-3">
      <SettingsRow
        label={translate(
          'auto.components.settings.ProjectClaudeAccountSetting.claudeAccount',
          'Claude account'
        )}
        description={
          preference.kind === 'account'
            ? translate(
                'auto.components.settings.ProjectClaudeAccountSetting.projectOverride',
                'Claude Code launches in this project switch to this account first.'
              )
            : translate(
                'auto.components.settings.ProjectClaudeAccountSetting.inheritedAccount',
                'No project override. Claude Code uses the globally selected account.'
              )
        }
        control={
          <Select value={selectedValue} onValueChange={handleChange}>
            <SelectTrigger size="sm" className="w-full min-w-52">
              <SelectValue>{selectedLabel}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={INHERIT_GLOBAL_VALUE}>
                {translate(
                  'auto.components.settings.ProjectClaudeAccountSetting.defaultAccount',
                  'Default (follow global account)'
                )}
              </SelectItem>
              {danglingAccountId ? (
                <SelectItem value={danglingAccountId}>
                  {translate(
                    'auto.components.settings.ProjectClaudeAccountSetting.removedAccount',
                    'Removed account'
                  )}
                </SelectItem>
              ) : null}
              {accounts.map((account) => (
                <SelectItem key={account.id} value={account.id}>
                  {getClaudeAccountOptionLabel(account)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <p className="text-xs text-muted-foreground">
        {translate(
          'auto.components.settings.ProjectClaudeAccountSetting.accountChangeHelp',
          "Applies when launching Claude Code in this project's workspaces. Orca switches the active Claude account before launch; running terminals keep their current account."
        )}
      </p>
    </section>
  )
}

function getClaudeAccountOptionLabel(account: ClaudeManagedAccountSummary): string {
  if (account.managedAuthRuntime === 'wsl') {
    return account.wslDistro
      ? translate(
          'auto.components.settings.ProjectClaudeAccountSetting.wslAccountWithDistro',
          '{{value0}} (WSL: {{value1}})',
          { value0: account.email, value1: account.wslDistro }
        )
      : translate(
          'auto.components.settings.ProjectClaudeAccountSetting.wslAccount',
          '{{value0}} (WSL)',
          { value0: account.email }
        )
  }
  return account.email
}
