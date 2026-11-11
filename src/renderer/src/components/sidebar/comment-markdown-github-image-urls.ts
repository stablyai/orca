import { createContext } from 'react'

export const GitHubBodyImageUrlsContext = createContext<
  Readonly<Record<string, string>> | undefined
>(undefined)
