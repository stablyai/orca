import type React from 'react'
import { CaseSensitive, GitBranch, Github, Gitlab, Sparkles } from 'lucide-react'

import { translate } from '@/i18n/i18n'
import type { SmartNameMode } from './smart-workspace-source-results'

export type MrStateFilter = 'opened' | 'merged' | 'closed' | 'all'

export type SmartWorkspaceNameModeOption = {
  id: SmartNameMode
  label: string
  Icon: React.ComponentType<{ className?: string }>
}

function LinearModeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg viewBox="0 0 24 24" aria-hidden className={className} fill="currentColor">
      <path d="M2.886 4.18A11.982 11.982 0 0 1 11.99 0C18.624 0 24 5.376 24 12.009c0 3.64-1.62 6.903-4.18 9.105L2.887 4.18ZM1.817 5.626l16.556 16.556c-.524.33-1.075.62-1.65.866L.951 7.277c.247-.575.537-1.126.866-1.65ZM.322 9.163l14.515 14.515c-.71.172-1.443.282-2.195.322L0 11.358a12 12 0 0 1 .322-2.195Zm-.17 4.862 9.823 9.824a12.02 12.02 0 0 1-9.824-9.824Z" />
    </svg>
  )
}

export function getMrStateFilters(): { id: MrStateFilter; label: string }[] {
  return [
    {
      id: 'opened',
      label: translate('auto.components.new.workspace.SmartWorkspaceNameField.622864b52a', 'Open')
    },
    {
      id: 'merged',
      label: translate('auto.components.new.workspace.SmartWorkspaceNameField.2319d87718', 'Merged')
    },
    {
      id: 'closed',
      label: translate('auto.components.new.workspace.SmartWorkspaceNameField.6fad211c66', 'Closed')
    },
    {
      id: 'all',
      label: translate('auto.components.new.workspace.SmartWorkspaceNameField.26824f60dd', 'All')
    }
  ]
}

export function getSmartWorkspaceNameModes(): SmartWorkspaceNameModeOption[] {
  return [
    {
      id: 'smart',
      label: translate('auto.components.new.workspace.SmartWorkspaceNameField.b3c60c2b7c', 'Smart'),
      Icon: Sparkles
    },
    {
      id: 'github',
      label: translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.0a180280bd',
        'GitHub'
      ),
      Icon: Github
    },
    {
      id: 'linear',
      label: translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.7a47af0565',
        'Linear'
      ),
      Icon: LinearModeIcon
    },
    {
      id: 'gitlab',
      label: translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.2cfc6be192',
        'GitLab'
      ),
      Icon: Gitlab
    },
    {
      id: 'branches',
      label: translate(
        'auto.components.new.workspace.SmartWorkspaceNameField.2e4c7c95fe',
        'Branch'
      ),
      Icon: GitBranch
    },
    {
      id: 'text',
      label: translate('auto.components.new.workspace.SmartWorkspaceNameField.6f07a18604', 'Name'),
      Icon: CaseSensitive
    }
  ]
}
