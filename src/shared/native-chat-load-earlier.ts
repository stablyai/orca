export const NATIVE_CHAT_LOAD_EARLIER_ERROR = 'Couldn’t load earlier messages'

export type NativeChatLoadEarlierState = {
  loadingEarlier: boolean
  loadEarlierError: string | null
}

export type NativeChatLoadEarlier = NativeChatLoadEarlierState & {
  hasMore: boolean
  loadEarlier: () => void
}

export const NATIVE_CHAT_LOAD_EARLIER_IDLE: NativeChatLoadEarlierState = {
  loadingEarlier: false,
  loadEarlierError: null
}

type NativeChatLoadEarlierRequest = { generation: number; id: number }

export type NativeChatLoadEarlierController = {
  begin: () => NativeChatLoadEarlierRequest | null
  invalidate: () => void
  isCurrent: (request: NativeChatLoadEarlierRequest) => boolean
  finish: (request: NativeChatLoadEarlierRequest) => boolean
}

export function createNativeChatLoadEarlierController(): NativeChatLoadEarlierController {
  let generation = 0
  let nextRequestId = 0
  let activeRequestId: number | null = null
  const isCurrent = (request: NativeChatLoadEarlierRequest): boolean =>
    request.generation === generation && request.id === activeRequestId

  return {
    begin: () => {
      if (activeRequestId !== null) {
        return null
      }
      nextRequestId += 1
      activeRequestId = nextRequestId
      return { generation, id: activeRequestId }
    },
    invalidate: () => {
      generation += 1
      activeRequestId = null
    },
    isCurrent,
    finish: (request) => {
      if (!isCurrent(request)) {
        return false
      }
      activeRequestId = null
      return true
    }
  }
}

export function canAutoLoadEarlier(
  hasMore: boolean | undefined,
  loadingEarlier: boolean | undefined,
  loadEarlierError: string | null | undefined
): boolean {
  return hasMore === true && loadingEarlier !== true && loadEarlierError == null
}

export function startNativeChatLoadEarlier<TResult, TSuccess extends TResult>(args: {
  controller: NativeChatLoadEarlierController
  read: () => Promise<TResult>
  isSuccess: (result: TResult) => result is TSuccess
  apply: (result: TSuccess) => void
  setState: (state: NativeChatLoadEarlierState) => void
}): void {
  const request = args.controller.begin()
  if (!request) {
    return
  }
  args.setState({ loadingEarlier: true, loadEarlierError: null })

  void (async () => {
    try {
      const result = await args.read()
      if (!args.controller.isCurrent(request)) {
        return
      }
      if (!args.isSuccess(result)) {
        if (args.controller.finish(request)) {
          args.setState({
            loadingEarlier: false,
            loadEarlierError: NATIVE_CHAT_LOAD_EARLIER_ERROR
          })
        }
        return
      }
      args.apply(result)
      if (args.controller.finish(request)) {
        args.setState(NATIVE_CHAT_LOAD_EARLIER_IDLE)
      }
    } catch {
      if (args.controller.finish(request)) {
        args.setState({
          loadingEarlier: false,
          loadEarlierError: NATIVE_CHAT_LOAD_EARLIER_ERROR
        })
      }
    }
  })()
}
