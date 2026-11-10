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
import { NativeChatClaudeMenuNavigation } from './NativeChatClaudeMenuNavigation'

export function NativeChatClaudeTerminalCommand({
  command,
  ptyId,
  readScreen,
  readDraft,
  disabled,
  remote,
  openTerminal,
  onDone,
  onActiveChange
}: {
  command: string
  ptyId: string
  readScreen: () => string | null
  readDraft: () => string | null
  disabled: boolean
  remote: boolean
  openTerminal?: () => void
  onDone?: () => void
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
  const screenRef = useRef<HTMLPreElement>(null)
  const doneRef = useRef<HTMLButtonElement>(null)
  const atPrompt = started && !pending && readDraft() !== null
  const focusRequest = useRef<{
    target: 'menu' | 'navigation' | 'draft'
    from: Element | null
  } | null>(null)
  const requestFocus = (target: 'menu' | 'navigation' | 'draft') => {
    focusRequest.current = { target, from: document.activeElement }
  }
  useEffect(() => {
    const requested = focusRequest.current
    if (!requested || pending || (requested.target !== 'draft' && (!started || !screen))) {
      return
    }
    if (requested.target === 'menu' && readDraft() !== null) {
      return
    }
    if (requested.target !== 'draft' && readDraft() === null && readScreen() !== screen) {
      return
    }
    focusRequest.current = null
    if (document.activeElement !== requested.from && document.activeElement !== document.body) {
      return
    }
    if (requested.target === 'draft') {
      onDone?.()
    } else {
      const target = readDraft() === null ? screenRef.current : doneRef.current
      target?.focus({ preventScroll: true })
    }
  }, [onDone, pending, readDraft, readScreen, screen, started])
  useEffect(() => {
    if (atPrompt && document.activeElement === screenRef.current) {
      doneRef.current?.focus({ preventScroll: true })
    }
  }, [atPrompt])
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
    requestFocus('menu')
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
      setStarted(false)
      focusRequest.current = null
      onActiveChange?.(false)
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
    requestFocus('navigation')
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
          {openTerminal && (
            <Button
              size="sm"
              className="pointer-coarse:min-h-11"
              variant="ghost"
              onClick={openTerminal}
            >
              {t('components.native-chat.mcp.openTerminal', 'Open terminal')}
            </Button>
          )}
        </div>
        {!started && (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              className="pointer-coarse:min-h-11"
              disabled={disabled || pending}
              onClick={() => void start()}
            >
              {t('components.native-chat.commands.runInChat', 'Run in Chat')}
            </Button>
            <Button
              size="sm"
              className="pointer-coarse:min-h-11"
              variant="ghost"
              disabled={disabled || pending}
              onClick={() => {
                if (readDraft() !== null || !readScreen()) {
                  setFailed(true)
                  return
                }
                requestFocus('menu')
                setStarted(true)
                onActiveChange?.(true)
              }}
            >
              {t('components.native-chat.commands.currentMenu', 'Show current menu')}
            </Button>
          </div>
        )}
        {started && (
          <>
            <pre
              ref={screenRef}
              className="scrollbar-sleek max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-muted p-3 font-mono text-chat-code focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              tabIndex={0}
              onKeyDown={(event) => {
                if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) {
                  return
                }
                const keys: Record<string, string> = {
                  ArrowUp: '\x1b[A',
                  ArrowDown: '\x1b[B',
                  ArrowLeft: '\x1b[D',
                  ArrowRight: '\x1b[C',
                  Enter: '\r',
                  Escape: '\x1b'
                }
                const key = keys[event.key]
                if (key) {
                  event.preventDefault()
                  event.stopPropagation()
                  if (!menuDisabled) {
                    void press(key)
                  }
                }
              }}
              aria-label={t('components.native-chat.commands.liveMenu', 'Live Claude menu')}
            >
              {screen && stripScrollbackAnsi(screen)}
            </pre>
            <div className="flex flex-wrap items-end justify-between gap-2">
              {!atPrompt && (
                <NativeChatClaudeMenuNavigation
                  disabled={menuDisabled}
                  onPress={(key) => void press(key)}
                />
              )}
              {!atPrompt && (
                <Button
                  size="sm"
                  className="pointer-coarse:min-h-11"
                  variant="ghost"
                  disabled={menuDisabled}
                  onClick={() => void press('\x1b')}
                >
                  {t('components.native-chat.commands.back', 'Back')}
                </Button>
              )}
              {atPrompt && (
                <Button
                  ref={doneRef}
                  size="sm"
                  className="pointer-coarse:min-h-11"
                  disabled={pending}
                  onClick={() => {
                    if (readDraft() === null) {
                      setFailed(true)
                      return
                    }
                    requestFocus('draft')
                    setStarted(false)
                    onActiveChange?.(false)
                  }}
                >
                  {t('components.native-chat.commands.done', 'Done')}
                </Button>
              )}
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
              'Select an item, or use Back to leave the menu. '
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
