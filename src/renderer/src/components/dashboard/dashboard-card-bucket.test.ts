import { describe, expect, it } from 'vitest'
import { dashboardBucketForCard } from './dashboard-card-bucket'

describe('dashboardBucketForCard', () => {
  it.each([
    [{ dotState: 'done', unseen: true }, 'attention'],
    [{ dotState: 'done', unseen: false }, 'done'],
    [{ dotState: 'waiting', unseen: false }, 'attention'],
    [{ dotState: 'blocked', unseen: true }, 'attention'],
    [{ dotState: 'working', unseen: true }, 'working'],
    [{ dotState: 'working', workingMode: 'monitoring', unseen: false }, 'working'],
    [{ dotState: 'idle', unseen: true }, 'idle']
  ] as const)('maps %o to %s', (card, bucket) => {
    expect(dashboardBucketForCard(card)).toBe(bucket)
  })
})
