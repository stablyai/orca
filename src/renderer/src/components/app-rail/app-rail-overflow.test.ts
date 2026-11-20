import { expect, it } from 'vitest'
import { appRailSlotCapacity, partitionAppRail } from './app-rail-overflow'

it('counts whole 36px slots', () => {
  expect(appRailSlotCapacity(36 * 4)).toBe(4)
  expect(appRailSlotCapacity(36 * 4 - 1)).toBe(3)
})

it('shows everything without More when it all fits', () => {
  expect(partitionAppRail(6, 9)).toEqual({
    shownDestinations: 6,
    more: false,
    helpInMore: false,
    settingsInMore: false
  })
})

it('folds destinations first, then Help, then Settings, keeping Workspaces and More', () => {
  expect(partitionAppRail(6, 8)).toMatchObject({
    shownDestinations: 4,
    more: true,
    helpInMore: false
  })
  expect(partitionAppRail(6, 4)).toMatchObject({
    shownDestinations: 0,
    helpInMore: false,
    settingsInMore: false
  })
  expect(partitionAppRail(6, 3)).toMatchObject({
    shownDestinations: 0,
    helpInMore: true,
    settingsInMore: false
  })
  expect(partitionAppRail(6, 2)).toMatchObject({
    shownDestinations: 0,
    helpInMore: true,
    settingsInMore: true
  })
  expect(partitionAppRail(6, 0)).toMatchObject({
    more: true,
    helpInMore: true,
    settingsInMore: true
  })
})
