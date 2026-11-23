import { memo, useCallback, useRef, useState } from 'react'
import { callRuntimeRpc } from '@/runtime/rpc/calls/runtime-rpc-call'
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel } from '@/components/ui/select'
import * as SelectPrimitive from 'radix-ui/select'
import {
  isRemoteBrowserInputOpenedDialogError,
  isRemoteBrowserPageMissingError
} from './remote-browser-stream-errors'
import type { RemoteBrowserOperationToken } from './remote-browser-stream-tokens'
import type { RemoteBrowserPageInputParams } from './remote-browser-page-input-params'
import {
  mapRemoteBrowserPageRect,
  readRemoteBrowserFrameGeometry,
  type RemoteBrowserRuntimeTarget
} from './remote-browser-page-input-model'
import {
  REMOTE_OPEN_SELECT_POPUP_EXPRESSION,
  REMOTE_SELECT_LIST_OPENED_EXPRESSION,
  buildRemoteSelectOptionChoiceExpression,
  groupRemoteSelectPopupOptions,
  readRemoteSelectListOpenedResult,
  readRemoteSelectPopupResult,
  type RemoteSelectPopup,
  type RemoteSelectPopupGroup
} from './remote-browser-select-popup-model'

const RPC_OPTIONS = { timeoutMs: 15_000, suppressFeatureInteraction: true }

type RemoteBrowserPress = {
  target: RemoteBrowserRuntimeTarget
  pageId: string
  operationToken: RemoteBrowserOperationToken
}

type RemoteSelectPopupState = RemoteSelectPopup &
  RemoteBrowserPress & {
    clientRect: { left: number; top: number; width: number; height: number }
  }

export function useRemoteBrowserSelectPopup({
  busy,
  isActive,
  pagePointerOwned,
  imageRef,
  remoteCssViewportSizeRef,
  remoteViewportSizeRef,
  frameMetadata,
  runtimeWorktree,
  enqueueRemoteInput,
  isCurrentRemoteOperationToken,
  closeMissingRemotePage,
  scheduleRemoteTabInfoRefresh,
  mountedRef,
  setPaneNotice
}: Omit<
  RemoteBrowserPageInputParams,
  | 'pickerAvailable'
  | 'inputQueue'
  | 'remoteViewportRef'
  | 'runtimeTarget'
  | 'lifecycle'
  | 'createRemoteOperationToken'
>): {
  /** Runs in the input queue right after a press's mouseDown, when the page opens its list. */
  checkSelectListAfterPress: (press: RemoteBrowserPress & { button: string }) => void
  /** Runs in the input queue after the release; waits only when the press opened a list. */
  readSelectPopupAfterPress: (press: RemoteBrowserPress & { button: string }) => Promise<void>
  /** Runs in the input queue before a key or press goes to the page; see the body for why. */
  closeSelectPopupForPageInput: () => void
  selectPopupElement: React.JSX.Element | null
} {
  const [selectPopup, setSelectPopup] = useState<RemoteSelectPopupState | null>(null)
  const listOpenedByPressRef = useRef<Promise<boolean> | null>(null)
  // A hidden or busy pane has no frame under the list to anchor it to.
  if (selectPopup && (!isActive || busy)) {
    setSelectPopup(null)
  }

  const checkSelectListAfterPress = ({
    button,
    ...press
  }: RemoteBrowserPress & { button: string }): void => {
    // Only a primary press opens a list; a page tool's press picks the element instead.
    listOpenedByPressRef.current =
      button === 'left' && !pagePointerOwned
        ? callRuntimeRpc(
            press.target,
            'browser.eval',
            {
              worktree: runtimeWorktree,
              page: press.pageId,
              expression: REMOTE_SELECT_LIST_OPENED_EXPRESSION
            },
            RPC_OPTIONS
          ).then(readRemoteSelectListOpenedResult, () => false)
        : null
  }

  const readSelectPopupAfterPress = async ({
    button,
    ...press
  }: RemoteBrowserPress & { button: string }): Promise<void> => {
    const listOpened = listOpenedByPressRef.current
    listOpenedByPressRef.current = null
    // Why: the check ran while the button was down, so for a press that opened no list it is
    // already answered and the next input does not wait.
    if (button !== 'left' || pagePointerOwned || !listOpened || !(await listOpened)) {
      return
    }
    let popup: RemoteSelectPopup | null = null
    try {
      popup = readRemoteSelectPopupResult(
        await callRuntimeRpc(
          press.target,
          'browser.eval',
          {
            worktree: runtimeWorktree,
            page: press.pageId,
            expression: REMOTE_OPEN_SELECT_POPUP_EXPRESSION
          },
          RPC_OPTIONS
        )
      )
    } catch {
      // The press already landed; a page that cannot answer just shows no list, as before.
      return
    }
    const image = imageRef.current
    if (!image || !mountedRef.current || !isCurrentRemoteOperationToken(press.operationToken)) {
      return
    }
    const clientRect = popup
      ? mapRemoteBrowserPageRect({
          rect: popup.rect,
          ...readRemoteBrowserFrameGeometry(image, {
            cssViewportSize: remoteCssViewportSizeRef.current,
            requestedViewportSize: remoteViewportSizeRef.current,
            frameMetadata
          })
        })
      : null
    if (!popup || !clientRect) {
      setSelectPopup(null)
      return
    }
    setSelectPopup({ ...popup, ...press, clientRect })
  }

  // Stable, so a screencast frame re-rendering the pane does not re-render a long option list.
  const chooseSelectOption = useCallback(
    (popup: RemoteSelectPopupState, index: number): void => {
      const option = popup.options[index]
      setSelectPopup(null)
      if (!option) {
        return
      }
      const expression = buildRemoteSelectOptionChoiceExpression({
        index,
        optionCount: popup.optionCount,
        label: option.label
      })
      void enqueueRemoteInput(async () => {
        if (!isCurrentRemoteOperationToken(popup.operationToken)) {
          return
        }
        try {
          await callRuntimeRpc(
            popup.target,
            'browser.eval',
            { worktree: runtimeWorktree, page: popup.pageId, expression },
            RPC_OPTIONS
          )
          // A change handler may navigate, as a language or country picker often does.
          scheduleRemoteTabInfoRefresh(popup.operationToken, 250)
        } catch (error) {
          // The stream shows a dialog the change handler opened; its error text is for agents.
          if (
            !isCurrentRemoteOperationToken(popup.operationToken) ||
            isRemoteBrowserInputOpenedDialogError(error)
          ) {
            return
          }
          if (isRemoteBrowserPageMissingError(error)) {
            closeMissingRemotePage(popup.pageId)
            return
          }
          setPaneNotice({
            kind: 'consequence',
            text: error instanceof Error ? error.message : 'Choosing the option failed.'
          })
        }
      })
    },
    [
      closeMissingRemotePage,
      enqueueRemoteInput,
      isCurrentRemoteOperationToken,
      runtimeWorktree,
      scheduleRemoteTabInfoRefresh,
      setPaneNotice
    ]
  )
  const dismissSelectPopup = useCallback((): void => setSelectPopup(null), [])
  // Keys reach the page only through the frame, so arrows and typing need it focused again.
  const refocusFrame = useCallback((): void => imageRef.current?.focus(), [imageRef])

  // Input queued behind an opening list was made before the list showed: a press elsewhere closes
  // it as it closes a native list, and a key goes to the page's select, which the read left focused,
  // so the list would no longer match the page.
  const closeSelectPopupForPageInput = useCallback((): void => setSelectPopup(null), [])

  return {
    checkSelectListAfterPress,
    readSelectPopupAfterPress,
    closeSelectPopupForPageInput,
    selectPopupElement: selectPopup ? (
      <RemoteBrowserSelectPopup
        popup={selectPopup}
        onChoose={chooseSelectOption}
        onDismiss={dismissSelectPopup}
        onClosed={refocusFrame}
      />
    ) : null
  }
}

/** The page's <select> list, drawn under the select box since the frame cannot show it. */
const RemoteBrowserSelectPopup = memo(function RemoteBrowserSelectPopup({
  popup,
  onChoose,
  onDismiss,
  onClosed
}: {
  popup: RemoteSelectPopupState
  onChoose: (popup: RemoteSelectPopupState, index: number) => void
  onDismiss: () => void
  onClosed: () => void
}): React.JSX.Element {
  return (
    <Select
      open
      value={popup.selectedIndex >= 0 ? String(popup.selectedIndex) : undefined}
      onValueChange={(value) => onChoose(popup, Number(value))}
      onOpenChange={(open) => {
        if (!open) {
          onDismiss()
        }
      }}
    >
      {/* An unstyled anchor over the page's own select box, which the frame already draws. */}
      <SelectPrimitive.Trigger
        aria-hidden
        tabIndex={-1}
        className="pointer-events-none fixed opacity-0"
        style={popup.clientRect}
      />
      <SelectContent
        data-testid="remote-browser-select-popup"
        position="popper"
        side="bottom"
        align="start"
        onCloseAutoFocus={(event) => {
          event.preventDefault()
          onClosed()
        }}
        // Tab leaves the list, as natively; the next Tab moves focus in the page.
        onKeyDown={(event) => {
          if (event.key === 'Tab') {
            event.preventDefault()
            onDismiss()
          }
        }}
      >
        {groupRemoteSelectPopupOptions(popup.options).map((group) =>
          group.label === null ? (
            group.options.map((option) => <RemoteSelectOption key={option.index} option={option} />)
          ) : (
            <SelectGroup key={group.options[0]?.index}>
              <SelectLabel>{group.label}</SelectLabel>
              {group.options.map((option) => (
                <RemoteSelectOption key={option.index} option={option} />
              ))}
            </SelectGroup>
          )
        )}
      </SelectContent>
    </Select>
  )
})

function RemoteSelectOption({
  option
}: {
  option: RemoteSelectPopupGroup['options'][number]
}): React.JSX.Element {
  return (
    <SelectItem value={String(option.index)} disabled={option.disabled}>
      {/* An empty option still takes a row natively. */}
      {option.label || ' '}
    </SelectItem>
  )
}
