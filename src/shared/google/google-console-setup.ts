// The Google Cloud steps an admin clicks through to make the team's Google app. Orca links each page
// already pointed at the project and reads only the page address to tick steps off; it never clicks.
import {
  GOOGLE_CHOICE_SERVICES,
  GOOGLE_SERVICE_INFO,
  googleChoices,
  type GoogleServiceChoice
} from './google-scopes'

export const GOOGLE_CONSOLE_ORIGIN = 'https://console.cloud.google.com'

/** Company: Internal audience. Personal (gmail.com): External, then Publish. */
export type GoogleAccountKind = 'company' | 'personal'

/** `links`: Personal only; Google keeps Publish greyed until Branding has a home page, a privacy link and their domain. */
export type GoogleConsoleStep = 'project' | 'apis' | 'branding' | 'links' | 'publish' | 'client'

/** What a personal app's Branding page gets so Publish unlocks; Google doesn't check them before verification. */
export const GOOGLE_PERSONAL_APP_LINKS = {
  homePage: 'https://www.onorca.dev',
  privacyPolicy: 'https://www.onorca.dev/privacy',
  authorizedDomain: 'onorca.dev'
} as const

export function googleConsoleSteps(kind: GoogleAccountKind): GoogleConsoleStep[] {
  return kind === 'personal'
    ? ['project', 'apis', 'branding', 'links', 'publish', 'client']
    : ['project', 'apis', 'branding', 'client']
}

/** The APIs to turn on for these choices; the People API (name lookup) always comes first. */
export function googleConsoleApiIds(choices: readonly GoogleServiceChoice[]): string[] {
  return [
    GOOGLE_SERVICE_INFO.contacts.api,
    ...googleChoices(choices).flatMap((choice) =>
      GOOGLE_CHOICE_SERVICES[choice].map((service) => GOOGLE_SERVICE_INFO[service].api)
    )
  ]
}

function consoleUrl(path: string, params: Record<string, string | undefined>): string {
  const url = new URL(path, GOOGLE_CONSOLE_ORIGIN)
  for (const [key, value] of Object.entries(params)) {
    if (value) {
      url.searchParams.set(key, value)
    }
  }
  return url.toString()
}

/** Where a console link points: the project once Orca has read its id. */
export type GoogleConsoleTarget = {
  projectId?: string
}

/** Opens a console page as `account`, in the browser that is signed in to several. */
export function withGoogleAccount(url: string, account: string | undefined): string {
  if (!account) {
    return url
  }
  const withAccount = new URL(url)
  withAccount.searchParams.set('authuser', account)
  return withAccount.toString()
}

/** One link that turns on only these APIs, in the project when Orca knows it. */
export function googleEnableApisUrl(
  choices: readonly GoogleServiceChoice[],
  target: GoogleConsoleTarget = {}
): string {
  return consoleUrl('/apis/enableflow', {
    apiid: googleConsoleApiIds(choices).join(','),
    project: target.projectId
  })
}

/** The page each step opens, pointed at the project once Orca has read its id. */
export function googleConsoleStepUrl(
  step: GoogleConsoleStep,
  options: { choices: readonly GoogleServiceChoice[] } & GoogleConsoleTarget
): string {
  const params = { project: options.projectId }
  switch (step) {
    case 'project':
      return consoleUrl('/projectcreate', {})
    case 'apis':
      return googleEnableApisUrl(options.choices, options)
    case 'branding':
      return consoleUrl('/auth/overview', params)
    case 'links':
      return consoleUrl('/auth/branding', params)
    case 'publish':
      return consoleUrl('/auth/audience', params)
    case 'client':
      return consoleUrl('/auth/clients/create', params)
  }
}

/** What one page address says about the steps; nothing is ever read from the page itself. */
export type GoogleConsoleAddress = {
  projectId: string | null
  page:
    | 'project-create'
    | 'enable-flow'
    /** Anywhere else under /apis once the enable flow has moved on. */
    | 'apis'
    | 'branding-wizard'
    | 'branding-overview'
    | 'audience'
    | 'client-create'
    /** Google refused to sign in inside this browser. */
    | 'sign-in-refused'
    | 'other'
}

const PROJECT_ID = /^[a-z][a-z0-9-]{4,61}[a-z0-9]$/

export function readGoogleConsoleAddress(address: string): GoogleConsoleAddress {
  let url: URL
  try {
    url = new URL(address)
  } catch {
    return { projectId: null, page: 'other' }
  }
  const project = url.searchParams.get('project')
  const projectId = project && PROJECT_ID.test(project) ? project : null
  if (url.hostname === 'accounts.google.com') {
    const refused =
      url.pathname.includes('/signin/rejected') || url.search.includes('disallowed_useragent')
    return { projectId: null, page: refused ? 'sign-in-refused' : 'other' }
  }
  if (url.origin !== GOOGLE_CONSOLE_ORIGIN) {
    return { projectId: null, page: 'other' }
  }
  const path = url.pathname.replace(/\/+$/, '')
  const page: GoogleConsoleAddress['page'] =
    path === '/projectcreate'
      ? 'project-create'
      : path === '/apis/enableflow'
        ? 'enable-flow'
        : path.startsWith('/apis/')
          ? 'apis'
          : path.startsWith('/auth/overview/create') || path.startsWith('/auth/branding')
            ? 'branding-wizard'
            : path === '/auth/overview'
              ? 'branding-overview'
              : path === '/auth/audience'
                ? 'audience'
                : path === '/auth/clients/create'
                  ? 'client-create'
                  : 'other'
  return { projectId, page }
}

/** What the browser has shown so far: the steps it ticked and the project it named. */
export type GoogleConsoleProgress = {
  done: GoogleConsoleStep[]
  projectId: string | null
  /** Pages seen, so a step ticks only when its own page moved on. */
  seen: GoogleConsoleAddress['page'][]
}

export const GOOGLE_CONSOLE_START: GoogleConsoleProgress = { done: [], projectId: null, seen: [] }

function tick(done: readonly GoogleConsoleStep[], step: GoogleConsoleStep): GoogleConsoleStep[] {
  return done.includes(step) ? [...done] : [...done, step]
}

/**
 * Folds one page address into the progress. A step ticks when the address shows its page finished:
 * a project id after the create page, the enable flow moving on, the sign-in screen's overview
 * after its wizard. The app key ticks only from its download, never from an address.
 */
export function advanceGoogleConsole(
  progress: GoogleConsoleProgress,
  address: string
): GoogleConsoleProgress {
  const { page, projectId } = readGoogleConsoleAddress(address)
  const seen = progress.seen.includes(page) ? progress.seen : [...progress.seen, page]
  let done = progress.done
  if (projectId && page !== 'project-create' && seen.includes('project-create')) {
    done = tick(done, 'project')
  }
  if (page === 'apis' && seen.includes('enable-flow')) {
    done = tick(done, 'apis')
  }
  if (page === 'branding-overview' && seen.includes('branding-wizard')) {
    done = tick(done, 'branding')
  }
  return { done, projectId: projectId ?? progress.projectId, seen }
}

/** The file name Share with teammates saves. */
export function googleAppExportFileName(projectId: string | undefined): string {
  return `${projectId ?? 'team'}-google-app.orca.json`
}
