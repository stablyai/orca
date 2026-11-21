import { expect, it } from 'vitest'
import { isSlackDirectMessage } from './slack-direct-message'

it('reads a DM from the cloud’s ids, and a thread, mention or not, as no DM', () => {
  // The bot's DM with its owner, as the cloud names it (channel twice), and an older two-part form.
  expect(
    isSlackDirectMessage({
      source: 'slack',
      externalId: 'T05BHT77GUF:D0CH5QFFC2C:D0CH5QFFC2C:U0CGB82KBC2'
    })
  ).toBe(true)
  expect(isSlackDirectMessage({ source: 'slack', externalId: 'T1:D7:U9' })).toBe(true)
  // A channel thread, where the bot may have been mentioned or just follows.
  expect(
    isSlackDirectMessage({
      source: 'slack',
      externalId: 'T05BHT77GUF:C0CCNS3K8BU:1795218253.690759:U0CGB82KBC2'
    })
  ).toBe(false)
  expect(isSlackDirectMessage({ source: 'slack', externalId: 'not-a-slack-id' })).toBe(false)
})

it('never reads another source’s id with Slack’s grammar', () => {
  expect(isSlackDirectMessage({ source: 'linear', externalId: 'T1:D7:D7:U9' })).toBe(false)
  expect(isSlackDirectMessage({ source: 'discord', externalId: 'T1:D7:D7:U9' })).toBe(false)
})
