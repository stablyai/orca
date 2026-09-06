import React from 'react'

import { useLinearIssueEditController } from '@/components/linear-item-drawer-edit-controller'
import { renderLinearIssueChipsLayout } from '@/components/linear-item-drawer-edit-chips-layout'
import { renderLinearIssuePropertiesLayout } from '@/components/linear-item-drawer-edit-properties-layout'
import type { LinearIssueEditSectionProps } from '@/components/linear-item-drawer-types'

export function LinearIssueEditSection(props: LinearIssueEditSectionProps): React.JSX.Element {
  const controller = useLinearIssueEditController(props)
  return controller.layout === 'properties'
    ? renderLinearIssuePropertiesLayout(controller)
    : renderLinearIssueChipsLayout(controller)
}
