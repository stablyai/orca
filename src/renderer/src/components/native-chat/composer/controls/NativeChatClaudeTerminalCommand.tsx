import { useEffect, useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { SecuritySurface } from '@/components/ui/security-surface'
import { useTranslate } from '@/i18n/use-translate'
import { installWindowVisibilityInterval } from '@/lib/window-visibility-interval'
import { sendRuntimePtyInputVerified } from '@/runtime/hosted-terminals/input/runtime-terminal-verified-input'
import type { NativeChatSendHandle } from '../../session/terminal/send/native-chat-runtime-send'
import { sendNativeChatObservedWrites } from '../../session/terminal/send/native-chat-observed-send'
import { waitForNativeChatPtyIdle } from '../../session/terminal/send/native-chat-pty-send-queue'
import {
  buildNativeChatPasteBytes,
  NATIVE_CHAT_SUBMIT
} from '../../../../../../shared/native-chat/input/native-chat-paste-bytes'
import { NATIVE_CHAT_SUBMIT_DELAY_MS } from '../../../../../../shared/native-chat/input/native-chat-answer-stepping'
import { stripScrollbackAnsi } from '../../session/terminal/assembly/native-chat-scrape-fallback'

export function NativeChatClaudeTerminalCommand({
  command,
  ptyId,
  readScreen,
  readDraft,
  disabled,
  remote,
  openTerminal,
  onActiveChange
}: {
  command: string
  ptyId: string
  readScreen: () => string | null
  readDraft: () => string | null
  disabled: boolean
  remote: boolean
  openTerminal?: () => void
  onActiveChange?: (active: boolean) => void
}): React.JSX.Element {
  const t = useTranslate()
  const [started, setStarted] = useState(false)
  const [screen, setScreen] = useState<string | null>(null)
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const handle = useRef<NativeChatSendHandle | null>(null)
  const live = useRef(true)
  const busy = useRef(false)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      handle.current?.cancel(true)
    }
  }, [])
  useEffect(() => {
    if (!started) {
      return
    }
    return installWindowVisibilityInterval({
      run: () => setScreen(readScreen()),
      intervalMs: 250,
      slowWhileUnfocused: true
    })
  }, [readScreen, started])
  const start = async () => {
    // Never clear or append to an unsubmitted terminal draft or an unreadable prompt.
    if (disabled || busy.current || readDraft() !== '') {
      setFailed(true)
      return
    }
    busy.current = true
    setPending(true)
    setFailed(false)
    setStarted(true)
    onActiveChange?.(true)
    await waitForNativeChatPtyIdle(ptyId)
    if (!live.current) {
      return
    }
    if (readDraft() !== '') {
      busy.current = false
      setPending(false)
      setFailed(true)
      return
    }
    handle.current = sendNativeChatObservedWrites(
      ptyId,
      [
        { data: buildNativeChatPasteBytes(`/${command}`), delayBeforeMs: 0 },
        { data: NATIVE_CHAT_SUBMIT, delayBeforeMs: NATIVE_CHAT_SUBMIT_DELAY_MS }
      ],
      {
        clearInput: '',
        stopOnUnconfirmed: true,
        onDeliverySettled: (delivered) => {
          if (live.current) {
            busy.current = false
            setPending(false)
            setFailed(!delivered)
          }
        }
      }
    )
  }
  const press = async (key: string) => {
    if (disabled || busy.current || !screen || readScreen() !== screen || readDraft() !== null) {
      setFailed(true)
      return
    }
    busy.current = true
    setPending(true)
    const delivered = await sendRuntimePtyInputVerified(ptyId, key, 'driving', {
      requireWriteSettlement: true
    }).catch(() => false)
    if (live.current) {
      busy.current = false
      setPending(false)
      setFailed(!delivered)
      setScreen(readScreen())
    }
  }
  const menuDisabled =
    disabled || pending || !screen || readDraft() !== null || readScreen() !== screen
  return (
    <SecuritySurface>
      <section
        aria-label={t('components.native-chat.commands.panelLabel', 'Claude /{{command}}', {
          command
        })}
        className="mb-2 space-y-3 rounded-md border border-border bg-card p-3 text-sm text-card-foreground"
      >
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="font-mono">/{command}</span>
          {!started && (
            <Button size="xs" disabled={disabled || pending} onClick={() => void start()}>
              {t('components.native-chat.commands.runInChat', 'Run in Chat')}
            </Button>
          )}
          {!started && (
            <Button
              size="xs"
              variant="outline"
              disabled={disabled || pending}
              onClick={() => {
                if (readDraft() !== null || !readScreen()) {
                  setFailed(true)
                  return
                }
                setStarted(true)
                onActiveChange?.(true)
              }}
            >
              {t('components.native-chat.commands.currentMenu', 'Show current menu')}
            </Button>
          )}
          {openTerminal && (
            <Button size="xs" variant="ghost" onClick={openTerminal}>
              {t('components.native-chat.mcp.openTerminal', 'Open terminal')}
            </Button>
          )}
        </div>
        {started && (
          <>
            <pre
              className="scrollbar-sleek max-h-64 overflow-auto whitespace-pre-wrap break-words font-mono text-chat-code"
              aria-label={t('components.native-chat.commands.liveMenu', 'Live Claude menu')}
            >
              {screen && stripScrollbackAnsi(screen)}
            </pre>
            <div className="flex flex-wrap gap-2">
              <Button
                size="xs"
                variant="outline"
                disabled={menuDisabled}
                onClick={() => void press('\x1b[D')}
              >
                {t('components.native-chat.commands.left', 'Left')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={menuDisabled}
                onClick={() => void press('\x1b[C')}
              >
                {t('components.native-chat.commands.right', 'Right')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={menuDisabled}
                onClick={() => void press('\x1b[A')}
              >
                {t('components.native-chat.commands.previous', 'Previous')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={menuDisabled}
                onClick={() => void press('\x1b[B')}
              >
                {t('components.native-chat.commands.next', 'Next')}
              </Button>
              <Button
                size="xs"
                variant="outline"
                disabled={menuDisabled}
                onClick={() => void press('\r')}
              >
                {t('components.native-chat.commands.select', 'Select')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={menuDisabled}
                onClick={() => void press('\x1b')}
              >
                {t('components.native-chat.commands.back', 'Back')}
              </Button>
              <Button
                size="xs"
                variant="ghost"
                disabled={pending}
                onClick={() => {
                  if (readDraft() === null) {
                    setFailed(true)
                    return
                  }
                  setStarted(false)
                  onActiveChange?.(false)
                }}
              >
                {t('components.native-chat.commands.done', 'Done')}
              </Button>
            </div>
          </>
        )}
        {failed && (
          <p role="alert" className="text-xs text-muted-foreground">
            {t(
              'components.native-chat.commands.inputNotConfirmed',
              'The terminal input is occupied, unavailable, or its delivery was not confirmed. Check the live menu or open the terminal before retrying.'
            )}
          </p>
        )}
        <p className="text-xs text-muted-foreground">
          {started &&
            t(
              'components.native-chat.commands.returnToPrompt',
              'Use Back to leave the menu, then Done to return to your draft. '
            )}
          {remote
            ? t(
                'components.native-chat.mcp.remoteBrowser',
                'Use a browser on the computer running Claude so the sign-in callback reaches that computer.'
              )
            : t(
                'components.native-chat.commands.browserConsent',
                'Complete any sign-in consent yourself in the browser opened by Claude.'
              )}
        </p>
      </section>
    </SecuritySurface>
  )
}
