import React from 'react'
import { SourceControlPanel } from './panel'

import '../review/hosted-review-header-chrome'

import '../sync/compare-summary'
import '../listing/conflict-status-cards'
import '../listing/too-many-changes-banner'
import '../listing/action-button'
import '../sync/use-branch-compare'
import '../commit/commit-area'
import '../commit/commit-shortcut'

import '../commit/commit-drafts'
import '../commit/component-gates'
import '../sync/remote-refresh'

import '../ai/text-generation-defaults'

function SourceControlInner(): React.JSX.Element {
  return <SourceControlPanel />
}
const SourceControl = React.memo(SourceControlInner)
export default SourceControl
