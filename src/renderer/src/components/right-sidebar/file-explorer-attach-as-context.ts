import { attachResolvedPathsToActiveNativeChatComposer } from '@/components/native-chat/native-chat-composer-path-attach'

export function attachExplorerFileAsContext(
  filePath: string,
  connectionId?: string | null
): boolean {
  return attachResolvedPathsToActiveNativeChatComposer([filePath], connectionId)
}
