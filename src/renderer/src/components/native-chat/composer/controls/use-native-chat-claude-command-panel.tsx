import { useState } from 'react'
import type { NativeChatStructuredComposerTransport } from '../submit/native-chat-structured-composer-transport'
import type { NativeChatComposerNotice } from './native-chat-composer-notice'
import { NativeChatMcpPanel } from './NativeChatMcpPanel'
import { NativeChatClaudeTerminalCommand } from './NativeChatClaudeTerminalCommand'
import { NativeChatClaudeSettingsCommand } from './NativeChatClaudeSettingsCommand'
import { nativeChatComposerTargetIsRemote } from '../submit/native-chat-composer-target'

export function useNativeChatClaudeCommandPanel(args: {
  targetPtyId: string | null
  structuredTransport?: NativeChatStructuredComposerTransport
  readTerminalScreen?: () => string | null
  readTerminalDraft?: () => string | null
  onSwitchToTerminal?: () => void
  onReturnToDraft?: () => void
  disabled: boolean
  isWorking?: boolean
}) {
  const [active, setActive] = useState<{ ptyId: string; command: string } | null>(null)
  const { targetPtyId, structuredTransport, readTerminalScreen, readTerminalDraft } = args
  const owned = !structuredTransport && active?.ptyId === targetPtyId ? active : null
  const inlineTerminal = Boolean(targetPtyId && readTerminalScreen && readTerminalDraft)
  return {
    inlineTerminal,
    disabled: args.disabled || owned !== null,
    panelFor(command: string | null, fallback: NativeChatComposerNotice | null) {
      if (structuredTransport && command) {
        return command === 'mcp' ? (
          <NativeChatMcpPanel
            key={`${structuredTransport.runtimeEnvironmentId}:${structuredTransport.sessionId}`}
            transport={structuredTransport}
            fallback={fallback}
          />
        ) : (
          <NativeChatClaudeSettingsCommand
            key={`${structuredTransport.runtimeEnvironmentId}:${structuredTransport.sessionId}`}
            transport={structuredTransport}
            command={command}
          />
        )
      }
      const shown = owned?.command ?? command
      return shown && targetPtyId && readTerminalScreen && readTerminalDraft ? (
        <NativeChatClaudeTerminalCommand
          key={`${targetPtyId}:${shown}`}
          command={shown}
          ptyId={targetPtyId}
          readScreen={readTerminalScreen}
          readDraft={readTerminalDraft}
          disabled={args.disabled || args.isWorking === true}
          remote={nativeChatComposerTargetIsRemote(targetPtyId)}
          openTerminal={args.onSwitchToTerminal}
          onDone={args.onReturnToDraft}
          onActiveChange={(started) =>
            setActive(started ? { ptyId: targetPtyId, command: shown } : null)
          }
        />
      ) : null
    }
  }
}
