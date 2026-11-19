import { describe, expect, it } from 'vitest'
import {
  advanceGoogleConsole,
  GOOGLE_CONSOLE_START,
  googleConsoleStepUrl,
  googleConsoleSteps,
  googleEnableApisUrl,
  readGoogleConsoleAddress,
  withGoogleAccount,
  type GoogleConsoleProgress
} from './google-console-setup'

const C = 'https://console.cloud.google.com'

function walk(addresses: string[]): GoogleConsoleProgress {
  return addresses.reduce(advanceGoogleConsole, GOOGLE_CONSOLE_START)
}

describe('Google console setup', () => {
  it('adds Publish only for a personal account', () => {
    expect(googleConsoleSteps('company')).toEqual(['project', 'apis', 'branding', 'client'])
    // Publish stays greyed until Branding has the links, so they come first.
    expect(googleConsoleSteps('personal')).toEqual([
      'project',
      'apis',
      'branding',
      'links',
      'publish',
      'client'
    ])
  })

  it('always turns on the People API, then only the chosen services', () => {
    const url = new URL(googleEnableApisUrl(['gmail'], { projectId: 'orca-google-41023' }))
    expect(url.pathname).toBe('/apis/enableflow')
    expect(url.searchParams.get('apiid')).toBe('people.googleapis.com,gmail.googleapis.com')
    expect(url.searchParams.get('project')).toBe('orca-google-41023')
    const all = new URL(googleEnableApisUrl(['files', 'calendar', 'gmail']))
    expect(all.searchParams.get('apiid')?.split(',')).toEqual([
      'people.googleapis.com',
      'gmail.googleapis.com',
      'calendar-json.googleapis.com',
      'drive.googleapis.com',
      'docs.googleapis.com',
      'sheets.googleapis.com'
    ])
    expect(all.searchParams.has('project')).toBe(false)
  })

  it('targets the known project and includes an account only when provided', () => {
    expect(googleConsoleStepUrl('client', { choices: ['gmail'], projectId: 'acme-orca' })).toBe(
      `${C}/auth/clients/create?project=acme-orca`
    )
    expect(googleConsoleStepUrl('project', { choices: ['gmail'], projectId: 'acme-orca' })).toBe(
      `${C}/projectcreate`
    )

    for (const step of googleConsoleSteps('personal')) {
      const url = new URL(googleConsoleStepUrl(step, { choices: ['gmail'], projectId: 'p' }))
      expect(url.searchParams.has('authuser')).toBe(false)
    }
    const account = 'alice@example.com'
    expect(withGoogleAccount(`${C}/apis/library/x?project=p`, account)).toBe(
      `${C}/apis/library/x?project=p&authuser=alice%40example.com`
    )
    expect(withGoogleAccount(`${C}/x`, undefined)).toBe(`${C}/x`)
  })

  it('reads a refused Google sign-in', () => {
    expect(
      readGoogleConsoleAddress('https://accounts.google.com/v3/signin/rejected?continue=x').page
    ).toBe('sign-in-refused')
    expect(readGoogleConsoleAddress('https://accounts.google.com/signin/v2/identifier').page).toBe(
      'other'
    )
    expect(readGoogleConsoleAddress('not a url').page).toBe('other')
  })

  it('ticks steps only when their own page moved on', () => {
    // A project already selected before the create page does not count.
    expect(walk([`${C}/home/dashboard?project=old-project-1`]).done).toEqual([])
    expect(walk([`${C}/auth/overview?project=acme-orca`]).done).toEqual([])
    const progress = walk([
      `${C}/projectcreate?project=old-project-1`,
      `${C}/home/dashboard?project=orca-google-41023`,
      `${C}/apis/enableflow?apiid=gmail.googleapis.com&project=orca-google-41023`,
      `${C}/apis/dashboard?project=orca-google-41023`,
      `${C}/auth/overview/create?project=orca-google-41023`,
      `${C}/auth/overview?project=orca-google-41023`
    ])
    expect(progress.done).toEqual(['project', 'apis', 'branding'])
    expect(progress.projectId).toBe('orca-google-41023')
  })
})
