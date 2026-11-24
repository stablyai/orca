import React from 'react'

import { useLinearIssueEditController } from '@/components/task-page/linear/item-drawer/linear-item-drawer-edit-controller'
import { renderLinearIssueChipsLayout } from '@/components/task-page/linear/item-drawer/linear-item-drawer-edit-chips-layout'
import { renderLinearIssuePropertiesLayout } from '@/components/task-page/linear/item-drawer/linear-item-drawer-edit-properties-layout'
import type { LinearIssueEditSectionProps } from '@/components/task-page/linear/item-drawer/linear-item-drawer-types'
import { useTranslate } from '@/i18n/use-translate'

export function LinearIssueEditSection(props: LinearIssueEditSectionProps): React.JSX.Element {
  const t = useTranslate()
  const controller = useLinearIssueEditController(props)
  return controller.layout === 'properties'
    ? renderLinearIssuePropertiesLayout(controller, t)
    : renderLinearIssueChipsLayout(controller, t)
}
