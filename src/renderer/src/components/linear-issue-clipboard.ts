import { toast } from 'sonner'

import {
  issueCopiedMessage,
  issueCopyFailedMessage,
  type IssueCopyTarget
} from './issue-copy-target-messages'

export async function copyLinearIssueText(text: string, target: IssueCopyTarget): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(text)
    toast.success(issueCopiedMessage(target))
  } catch {
    toast.error(issueCopyFailedMessage(target))
  }
}
