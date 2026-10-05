import React from 'react'
import { MacFolderAccessFixDialog } from '@/components/shared/MacFolderAccessFixDialog'
import { useMacosTccPromptNotice } from './useMacosTccPromptNotice'
import { useMacTccAttributionSeveredNotice } from './useMacTccAttributionSeveredNotice'

export function MacosTccPromptNoticeHost(): React.JSX.Element {
  useMacosTccPromptNotice()
  // Why: severed daemon attribution only showed in Settings (#13594); toast the remedy at launch/focus.
  useMacTccAttributionSeveredNotice()
  // Why here: the folder-access toast raises this dialog, and both must outlive any one screen.
  return <MacFolderAccessFixDialog />
}
