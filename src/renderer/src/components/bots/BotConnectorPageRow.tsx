import React, { useEffect, useRef } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { useTranslate } from '@/i18n/use-translate'
import { cn } from '@/lib/class-names'
import { AttentionDot } from './AttentionDot'
import { BARE_LOGO_BOX, BotLogoBare } from './apps/BotAppRow'
import {
  BotConnectorPageSections,
  BotConnectorRowKey,
  openBotConnectorPage
} from './bot-connector-page'
import {
  BotConnectorMenu,
  RowFixOrStatus,
  RowName,
  STATUS_DOT_CLASSES,
  type BotConnectorRowFrameProps
} from './bot-connector-row-parts'
import { botConnectorTitleText } from './bot-connector-titles'

/** A connector list's row, or its own page while that shows; its dialogs stay mounted either way. */
export function BotConnectorPageRow({
  rowKey,
  page,
  ...props
}: BotConnectorRowFrameProps & { rowKey: string; page: string | null }): React.JSX.Element {
  const t = useTranslate()
  const shown = page === rowKey
  const open = (): void => openBotConnectorPage(rowKey)
  const rowButton = useRef<HTMLButtonElement>(null)
  const backButton = useRef<HTMLButtonElement>(null)
  const wasShown = useRef(false)
  useEffect(() => {
    // Into the page: focus Back. Back to the list: focus the row that opened it.
    if (shown && !wasShown.current) {
      backButton.current?.focus({ preventScroll: true })
    } else if (!shown && wasShown.current && page === null) {
      rowButton.current?.focus()
    }
    wasShown.current = shown
  }, [shown, page])
  // Continue an explicitly started sign-in when the owner is still on the list.
  const defaultOpen = props.defaultOpen ?? false
  const sawDefaultOpen = useRef(defaultOpen)
  useEffect(() => {
    if (defaultOpen && !sawDefaultOpen.current && page === null) {
      openBotConnectorPage(rowKey)
    }
    sawDefaultOpen.current = defaultOpen
  }, [defaultOpen, page, rowKey])
  const { actions, name } = props
  const nameText = typeof name === 'string' ? name : botConnectorTitleText(name)
  return (
    <div
      hidden={page !== null && !shown}
      className={
        shown
          ? 'flex flex-col motion-safe:animate-in motion-safe:fade-in-0 motion-safe:slide-in-from-right-2 motion-safe:duration-150'
          : 'group'
      }
    >
      {shown ? (
        <>
          <Button
            ref={backButton}
            variant="ghost"
            size="xs"
            className="-ml-1.5 self-start"
            onClick={() => openBotConnectorPage(null)}
          >
            <ChevronLeft />
            {t('settings.bots.connectors', 'Connectors')}
          </Button>
          <div className="flex items-start gap-3 pt-3 pb-1">
            <span className="shrink-0 *:size-10!">
              {props.logo ?? (
                <span className="flex items-center justify-center rounded-lg bg-muted">
                  {props.icon}
                </span>
              )}
            </span>
            <div className="min-w-0 flex-1">
              <h2 className="line-clamp-2 text-base leading-5 font-semibold break-words">
                {nameText}
              </h2>
              <p className="mt-0.5 truncate text-xs text-muted-foreground">{props.description}</p>
            </div>
            <div className="flex shrink-0 items-center gap-1.5 pt-0.5">
              {props.notice}
              <RowFixOrStatus
                props={props.status?.listOnly ? { ...props, status: null } : props}
                onOpen={open}
              />
              {props.trailing}
              {actions ? (
                <BotConnectorMenu
                  name={nameText}
                  actions={actions}
                  alwaysShown
                  popover={props.menuPopover}
                />
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <div className="group/header relative flex min-h-[52px] items-center gap-3 rounded-lg px-2 py-2 transition-colors hover:bg-accent/40">
          {/* Every row's logo is its bare mark in one 20 px box; the page's heading keeps its tile. */}
          <BotLogoBare.Provider value={true}>
            {props.logo ?? (
              <span className={cn(BARE_LOGO_BOX, 'text-muted-foreground')}>{props.icon}</span>
            )}
          </BotLogoBare.Provider>
          <div className="min-w-0 flex-1">
            {/* Stretched over the row, so a click anywhere but the fix opens its page. */}
            <button
              ref={rowButton}
              type="button"
              onClick={open}
              className="flex max-w-full min-w-0 text-left text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-[3px] focus-visible:after:ring-ring/50"
            >
              <RowName name={name} />
            </button>
            {/* What needs the owner takes the line; its fix waits on the page. */}
            {props.fix || props.status ? (
              <p className="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                {props.fix ? (
                  <AttentionDot />
                ) : (
                  <span
                    className={STATUS_DOT_CLASSES[props.status?.tone ?? 'neutral']}
                    aria-hidden
                  />
                )}
                <span className="truncate">{props.fix?.label ?? props.status?.label}</span>
              </p>
            ) : (
              <p className="truncate text-xs text-muted-foreground">{props.description}</p>
            )}
          </div>
          {props.notice}
          {props.checking ? (
            <LoaderCircle className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : null}
          {props.trailing}
          <ChevronRight
            aria-hidden
            className="pointer-events-none size-4 shrink-0 text-muted-foreground group-hover/header:text-foreground"
          />
        </div>
      )}
      <div hidden={!shown} className={shown ? 'flex flex-col' : undefined}>
        <BotConnectorRowKey.Provider value={null}>
          <BotConnectorPageSections.Provider value={true}>
            {props.children}
          </BotConnectorPageSections.Provider>
        </BotConnectorRowKey.Provider>
      </div>
    </div>
  )
}
