import { createContext } from 'react'

export type NativeChatForkSurface = {
  eligibleItemIds: ReadonlySet<string>
  pending: boolean
  request: (itemId: string) => Promise<void>
}

export const NativeChatForkContext = createContext<NativeChatForkSurface | undefined>(undefined)
