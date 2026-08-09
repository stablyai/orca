import { toast } from 'sonner'
import { translate } from '@/i18n/i18n'

export async function copyArtifactLink(shareUrl: string): Promise<void> {
  try {
    await window.api.ui.writeClipboardText(shareUrl)
    toast.success(translate('auto.components.artifacts.copySuccess', 'Artifact link copied'))
  } catch {
    toast.error(translate('auto.components.artifacts.copyFailed', 'Could not copy artifact link'))
  }
}

export function openArtifactInBrowser(shareUrl: string): void {
  void window.api.shell.openUrl(shareUrl)
}
