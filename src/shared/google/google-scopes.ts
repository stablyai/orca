// What Orca asks Google for at sign-in. The person picks services (Gmail, Calendar, Files); name
// lookup and the signed-in address are always asked for. Adding a service later asks again for the
// union, so nothing already allowed is lost.

/** The services a bot's tools call; readiness reads each one. */
export const GOOGLE_SERVICES = ['gmail', 'calendar', 'drive', 'docs', 'sheets', 'contacts'] as const
export type GoogleService = (typeof GOOGLE_SERVICES)[number]

/** What a person picks at Connect: Files is Drive, Docs and Sheets together. */
export const GOOGLE_SERVICE_CHOICES = ['gmail', 'calendar', 'files'] as const
export type GoogleServiceChoice = (typeof GOOGLE_SERVICE_CHOICES)[number]

const SCOPE = 'https://www.googleapis.com/auth/'

export type GoogleServiceInfo = {
  label: string
  /** The scopes the service's tools need; any one missing is "Needs permission". */
  scopes: readonly string[]
  /** Google's API name, for the Console page that turns the API on. */
  api: string
}

/** Every scope Orca asks for is listed here, once, under the service that needs it. */
export const GOOGLE_SERVICE_INFO: Record<GoogleService, GoogleServiceInfo> = {
  // gmail.modify covers read, draft, send, labels and archive.
  gmail: { label: 'Gmail', scopes: [`${SCOPE}gmail.modify`], api: 'gmail.googleapis.com' },
  calendar: {
    label: 'Calendar',
    // calendarlist.readonly: which calendars there are, their names and time zones;
    // events.freebusy: when other people are busy, for suggest-time.
    scopes: [
      `${SCOPE}calendar.events`,
      `${SCOPE}calendar.calendarlist.readonly`,
      `${SCOPE}calendar.events.freebusy`
    ],
    api: 'calendar-json.googleapis.com'
  },
  drive: { label: 'Drive', scopes: [`${SCOPE}drive`], api: 'drive.googleapis.com' },
  docs: { label: 'Docs', scopes: [`${SCOPE}documents`], api: 'docs.googleapis.com' },
  sheets: { label: 'Sheets', scopes: [`${SCOPE}spreadsheets`], api: 'sheets.googleapis.com' },
  // Name lookup, read-only: the person's contacts, people they emailed, and the company directory.
  contacts: {
    label: 'Contacts',
    scopes: [
      `${SCOPE}contacts.readonly`,
      `${SCOPE}contacts.other.readonly`,
      `${SCOPE}directory.readonly`
    ],
    api: 'people.googleapis.com'
  }
}

/** The services each choice covers. */
export const GOOGLE_CHOICE_SERVICES: Record<GoogleServiceChoice, readonly GoogleService[]> = {
  gmail: ['gmail'],
  calendar: ['calendar'],
  files: ['drive', 'docs', 'sheets']
}

const servicesScopes = (services: readonly GoogleService[]) =>
  services.flatMap((service) => GOOGLE_SERVICE_INFO[service].scopes)

/** Asked for whatever is picked: who signed in, and name lookup. */
export const GOOGLE_BASE_SCOPES: readonly string[] = [
  'openid',
  'email',
  ...servicesScopes(['contacts'])
]

/** Choices in their canonical order, each once. */
export function googleChoices(choices: Iterable<GoogleServiceChoice>): GoogleServiceChoice[] {
  const picked = new Set(choices)
  return GOOGLE_SERVICE_CHOICES.filter((choice) => picked.has(choice))
}

/** The scopes one sign-in asks for: the base set plus every picked choice's. */
export function googleSignInScopes(choices: readonly GoogleServiceChoice[]): string[] {
  return [
    ...GOOGLE_BASE_SCOPES,
    ...googleChoices(choices).flatMap((choice) => servicesScopes(GOOGLE_CHOICE_SERVICES[choice]))
  ]
}

/** The choices a grant fully covers. */
export function grantedGoogleChoices(scopes: readonly string[]): GoogleServiceChoice[] {
  const granted = new Set(scopes)
  return GOOGLE_SERVICE_CHOICES.filter((choice) =>
    servicesScopes(GOOGLE_CHOICE_SERVICES[choice]).every((scope) => granted.has(scope))
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
