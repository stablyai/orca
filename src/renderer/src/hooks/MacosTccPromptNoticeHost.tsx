import { useMacosTccPromptNotice } from './useMacosTccPromptNotice'
import { useMacTccAttributionSeveredNotice } from './useMacTccAttributionSeveredNotice'

export function MacosTccPromptNoticeHost(): null {
  useMacosTccPromptNotice()
  // Why: severed daemon attribution only showed in Settings (#13594); toast the remedy at launch/focus.
  useMacTccAttributionSeveredNotice()
  return null
}
