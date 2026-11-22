// What Orca asks Google for at sign-in. The person picks services (Gmail, Calendar, Files); name
// lookup and the signed-in address are always asked for. Adding a service later asks again for the
// union, so nothing already allowed is lost. Read-draft access asks only for reading plus Gmail
// drafts, so Google itself refuses sending and every other write.

/** The services a bot's tools call; readiness reads each one. */
export const GOOGLE_SERVICES = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'] as const
export type GoogleService = (typeof GOOGLE_SERVICES)[number]

/** What a person picks at Connect: Files is Drive, Docs and Sheets together. */
export const GOOGLE_SERVICE_CHOICES = ['gmail', 'calendar', 'files'] as const
export type GoogleServiceChoice = (typeof GOOGLE_SERVICE_CHOICES)[number]

/** How much a sign-in asks Google for: everything the tools do, or reading plus Gmail drafts. */
export const GOOGLE_ACCESS_LEVELS = ['full', 'read-draft'] as const
export type GoogleAccess = (typeof GOOGLE_ACCESS_LEVELS)[number]

const SCOPE = 'https://www.googleapis.com/auth/'

export type GoogleServiceInfo = {
  label: string
  /** The scopes the service's tools need; any one missing is "Needs permission". */
  scopes: readonly string[]
  /** The read-draft set: Google refuses every write but a Gmail draft. */
  readDraftScopes: readonly string[]
  /** Google's API name, for the Console page that turns the API on. */
  api: string
}

// Name lookup, read-only: the person's contacts, people they emailed, and the company directory.
const CONTACTS_SCOPES = [
  `${SCOPE}contacts.readonly`,
  `${SCOPE}contacts.other.readonly`,
  `${SCOPE}directory.readonly`
]

/** Every scope Orca asks for is listed here, once, under the service that needs it. */
export const GOOGLE_SERVICE_INFO: Record<GoogleService, GoogleServiceInfo> = {
  // gmail.modify covers read, draft, send, labels and archive.
  gmail: {
    label: 'Gmail',
    scopes: [`${SCOPE}gmail.modify`],
    readDraftScopes: [`${SCOPE}gmail.readonly`, `${SCOPE}gmail.drafts`],
    api: 'gmail.googleapis.com'
  },
  calendar: {
    label: 'Calendar',
    // calendarlist.readonly: which calendars there are, their names and time zones;
    // events.freebusy: when other people are busy, for suggest-time.
    scopes: [
      `${SCOPE}calendar.events`,
      `${SCOPE}calendar.calendarlist.readonly`,
      `${SCOPE}calendar.events.freebusy`
    ],
    readDraftScopes: [`${SCOPE}calendar.readonly`, `${SCOPE}calendar.freebusy`],
    api: 'calendar-json.googleapis.com'
  },
  drive: {
    label: 'Drive',
    scopes: [`${SCOPE}drive`],
    readDraftScopes: [`${SCOPE}drive.readonly`],
    api: 'drive.googleapis.com'
  },
  docs: {
    label: 'Docs',
    scopes: [`${SCOPE}documents`],
    readDraftScopes: [`${SCOPE}documents.readonly`],
    api: 'docs.googleapis.com'
  },
  sheets: {
    label: 'Sheets',
    scopes: [`${SCOPE}spreadsheets`],
    readDraftScopes: [`${SCOPE}spreadsheets.readonly`],
    api: 'sheets.googleapis.com'
  },
  contacts: {
    label: 'Contacts',
    scopes: CONTACTS_SCOPES,
    readDraftScopes: CONTACTS_SCOPES,
    api: 'people.googleapis.com'
  }
}

/** The services each choice covers. */
export const GOOGLE_CHOICE_SERVICES: Record<GoogleServiceChoice, readonly GoogleService[]> = {
  gmail: ['gmail'],
  calendar: ['calendar'],
  files: ['drive', 'docs', 'sheets']
}

const accessScopes = (service: GoogleService, access: GoogleAccess) =>
  access === 'full'
    ? GOOGLE_SERVICE_INFO[service].scopes
    : GOOGLE_SERVICE_INFO[service].readDraftScopes

const servicesScopes = (services: readonly GoogleService[], access: GoogleAccess) =>
  services.flatMap((service) => accessScopes(service, access))

/** Whether a grant covers a service at either access level. */
export function googleServiceGranted(
  service: GoogleService,
  granted: ReadonlySet<string>
): boolean {
  return GOOGLE_ACCESS_LEVELS.some((access) =>
    accessScopes(service, access).every((scope) => granted.has(scope))
  )
}

/** Choices in their canonical order, each once. */
export function googleChoices(choices: Iterable<GoogleServiceChoice>): GoogleServiceChoice[] {
  const picked = new Set(choices)
  return GOOGLE_SERVICE_CHOICES.filter((choice) => picked.has(choice))
}

/** The scopes one sign-in asks for: who signed in, name lookup, and every picked choice's. */
export function googleSignInScopes(
  choices: readonly GoogleServiceChoice[],
  access: GoogleAccess = 'full'
): string[] {
  return [
    'openid',
    'email',
    ...(access === 'read-draft' ? ['profile'] : []),
    ...servicesScopes(['contacts'], access),
    ...googleChoices(choices).flatMap((choice) =>
      servicesScopes(GOOGLE_CHOICE_SERVICES[choice], access)
    )
  ]
}

/** The choices a grant fully covers. */
export function grantedGoogleChoices(scopes: readonly string[]): GoogleServiceChoice[] {
  const granted = new Set(scopes)
  return GOOGLE_SERVICE_CHOICES.filter((choice) =>
    GOOGLE_CHOICE_SERVICES[choice].every((service) => googleServiceGranted(service, granted))
  )
}

/** The services readiness reads for these choices; name lookup (contacts) always. */
export function googleChoiceServices(choices: readonly GoogleServiceChoice[]): GoogleService[] {
  const services = new Set<GoogleService>([
    'contacts',
    ...googleChoices(choices).flatMap((choice) => GOOGLE_CHOICE_SERVICES[choice])
  ])
  return GOOGLE_SERVICES.filter((service) => services.has(service))
}

/** The Console page that turns one API on, in the client's project when Orca knows it. */
export function googleApiEnableUrl(service: GoogleService, projectId?: string): string {
  const url = new URL(
    `https://console.cloud.google.com/apis/library/${GOOGLE_SERVICE_INFO[service].api}`
  )
  if (projectId) {
    url.searchParams.set('project', projectId)
  }
  return url.toString()
}
