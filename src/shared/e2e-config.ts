export type E2EConfig = {
  enabled: boolean
  headless: boolean
  exposeStore: boolean
  userDataDir: string | null
}

type E2EConfigInput = {
  headless?: boolean
  exposeStore?: boolean
  userDataDir?: string | null
}

export function createE2EConfig(input: E2EConfigInput): E2EConfig {
  const userDataDir = input.userDataDir?.trim() || null
  const headless = Boolean(input.headless)
  const exposeStore = Boolean(input.exposeStore)

  return {
    enabled: headless || exposeStore || userDataDir !== null,
    headless,
    exposeStore,
    userDataDir
  }
}
