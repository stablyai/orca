import { expect, it } from 'vitest'
import { buildBrowserCookieImportPickerSections } from './browser-cookie-import-picker-rows'

it('offers a remembered source only while that exact profile directory is detected', () => {
  const person = { name: 'Person 1', directory: 'Profile 1' }
  const work = { name: 'Work', directory: 'Profile 2' }
  const lastUsed = { family: 'chrome', profile: 'Profile 2' }
  const sections = (profiles: (typeof work)[]) =>
    buildBrowserCookieImportPickerSections(
      [{ family: 'chrome', label: 'Google Chrome', profiles, selectedProfile: 'Profile 2' }],
      lastUsed,
      ''
    )

  expect(sections([person, work])[0].rows[0].source.profile).toBe('Profile 2')
  expect(sections([work]).map((section) => section.rows[0].source.profile)).toEqual([
    'Profile 2',
    'Profile 2'
  ])
  expect(sections([person]).map((section) => section.rows[0].source.profile)).toEqual(['Profile 1'])
})
