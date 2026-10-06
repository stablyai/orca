/** What one direction of a network path does to packets, and the netem arguments that say so. */

export type NetworkLoss =
  | { kind: 'none' }
  /** Each packet dropped independently. Real links rarely lose packets this way. */
  | { kind: 'random'; percent: number }
  /**
   * Gilbert-Elliott: the link flips between a good and a bad state. `enterBadPercent` and
   * `leaveBadPercent` are the per-packet chances of switching; `lossInBadPercent` is the drop
   * rate while bad (every packet, if omitted). Long-run loss is enter / (enter + leave) and the
   * mean burst is 1 / leave packets. The state advances per packet, not per second, so an outage
   * of a given duration has to be a timed cut, not a loss setting.
   */
  | { kind: 'bursty'; enterBadPercent: number; leaveBadPercent: number; lossInBadPercent?: number }

/** One direction of a path. */
export type NetworkDirectionShape = {
  delayMs: number
  /** Standard deviation of the delay. Requires `rateKbit`. */
  jitterMs?: number
  /** Shape of the delay spread; `paretonormal` and `pareto` have long tails. Default `normal`. */
  jitterDistribution?: 'normal' | 'pareto' | 'paretonormal'
  loss?: NetworkLoss
  /** Bandwidth cap in kbit/s. Omit for no cap. */
  rateKbit?: number
  /** Packets the path will hold before dropping more. netem's default is 1000. */
  queuePackets?: number
}

export type NetworkLinkShape = {
  uplink: NetworkDirectionShape
  downlink: NetworkDirectionShape
}

export type NetworkOutageSchedule = {
  /** Seconds from the end of one outage to the start of the next. */
  everySeconds: number
  forSeconds: number
}

/** The `tc ... netem` arguments for one direction. Exported so a test can assert on them. */
export function netemArguments(shape: NetworkDirectionShape): string[] {
  const args = ['delay', `${shape.delayMs}ms`]
  if (shape.jitterMs && shape.jitterMs > 0) {
    if (!shape.rateKbit) {
      // Why: netem releases each packet at its own delayed time, so jitter with no rate limit
      // reorders packets, which a real first-in-first-out path does not do.
      throw new Error('jitterMs needs rateKbit: jitter without a rate limit reorders packets')
    }
    args.push(`${shape.jitterMs}ms`, 'distribution', shape.jitterDistribution ?? 'normal')
  }
  const loss = shape.loss ?? { kind: 'none' }
  if (loss.kind === 'random') {
    args.push('loss', 'random', `${loss.percent}%`)
  } else if (loss.kind === 'bursty') {
    args.push('loss', 'gemodel', `${loss.enterBadPercent}%`, `${loss.leaveBadPercent}%`)
    if (loss.lossInBadPercent !== undefined) {
      // gemodel p r 1-h 1-k: 1-h is the loss rate in the bad state, 1-k in the good one.
      args.push(`${loss.lossInBadPercent}%`, '0%')
    }
  }
  if (shape.rateKbit) {
    args.push('rate', `${shape.rateKbit}kbit`)
  }
  if (shape.queuePackets) {
    args.push('limit', String(shape.queuePackets))
  }
  return args
}
