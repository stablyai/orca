import React from 'react'
import { renderSmartWorkspaceNameField } from './smart-workspace-name-field-surface'
import type { SmartWorkspaceNameFieldProps } from './smart-workspace-name-field-model'
import { useSmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'

export type {
  SmartWorkspaceNameSelection,
  SmartWorkspaceNameFieldProps
} from './smart-workspace-name-field-model'
export { canUseGitLabSmartSource } from './smart-workspace-provider-availability'
export { getRepoSlugCached } from './smart-workspace-repo-slug'

export default function SmartWorkspaceNameField(
  props: SmartWorkspaceNameFieldProps
): React.JSX.Element {
  const controller = useSmartWorkspaceNameFieldController(props)
  return renderSmartWorkspaceNameField(controller)
}
