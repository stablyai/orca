import React from 'react'
import { renderSmartWorkspaceNameField } from './smart-workspace-name-field-surface'
import type { SmartWorkspaceNameFieldProps } from './smart-workspace-name-field-model'
import { useSmartWorkspaceNameFieldController } from './use-smart-workspace-name-field-controller'
import { useTranslate } from '../../i18n/use-translate'

export default function SmartWorkspaceNameField(
  props: SmartWorkspaceNameFieldProps
): React.JSX.Element {
  const t = useTranslate()
  const controller = useSmartWorkspaceNameFieldController(props)
  return renderSmartWorkspaceNameField(controller, t)
}
