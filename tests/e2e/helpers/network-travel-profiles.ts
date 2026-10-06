import {
  scheduleNetworkOutages,
  shapeImpairedNetwork,
  type ImpairedNetworkPath
} from './impaired-network-link'
import type {
  NetworkDirectionShape,
  NetworkLinkShape,
  NetworkOutageSchedule
} from './netem-arguments'

/**
 * Network conditions a person meets while travelling, as netem settings.
 *
 * Each profile says where its numbers come from. "measured" means a published measurement of that
 * kind of network; "estimated" means nothing attributable was found and the value is a judgement.
 * Loss burst lengths are estimated in every profile: no source publishes them. None of these has
 * been validated against the network it imitates.
 *
 * Queue sizes follow netem's `limit`, which counts packets being delayed as well as queued:
 * (one-way delay + intended queue depth) x rate / 12,000 bits.
 */
export type NetworkTravelProfile = {
  name: string
  describes: string
  shape: NetworkLinkShape
  /** Timed cuts on top of the shape. Loss settings cannot produce an outage of a set length. */
  outages?: NetworkOutageSchedule
  basis: string
}

const paretonormal = 'paretonormal' as const

function direction(
  base: Omit<NetworkDirectionShape, 'rateKbit' | 'queuePackets'>,
  rateKbit: number,
  queuePackets: number
): NetworkDirectionShape {
  return { ...base, rateKbit, queuePackets }
}

/** `base` applies to both directions; rate and queue are given as [down, up]. */
function shape(
  base: Omit<NetworkDirectionShape, 'rateKbit' | 'queuePackets'>,
  rateKbit: [down: number, up: number],
  queuePackets: [down: number, up: number]
): NetworkLinkShape {
  return {
    downlink: direction(base, rateKbit[0], queuePackets[0]),
    uplink: direction(base, rateKbit[1], queuePackets[1])
  }
}

export const NETWORK_TRAVEL_PROFILES = {
  homeWifi: {
    name: 'home-wifi',
    describes: 'Home Wi-Fi on a decent broadband line',
    shape: shape(
      {
        delayMs: 12,
        jitterMs: 8,
        jitterDistribution: paretonormal,
        loss: { kind: 'bursty', enterBadPercent: 0.1, leaveBadPercent: 50 }
      },
      [50_000, 20_000],
      [500, 200]
    ),
    basis:
      'Estimated. Wi-Fi hop latency 3/20/250 ms at p50/p90/p99 on a campus network (Sui et al., MobiSys 2016) guides the jitter.'
  },
  lteStationary: {
    name: 'lte-stationary',
    describes: 'Good LTE, standing still',
    shape: shape(
      { delayMs: 35, jitterMs: 3, loss: { kind: 'random', percent: 0.06 } },
      [30_000, 10_000],
      [1000, 400]
    ),
    basis:
      'Measured: median RTT 69.5 ms and RTT jitter 5.6 ms (Huang et al., MobiSys 2012); median retransmission rate 0.06% (Huang et al., SIGCOMM 2013). Rates from US driving medians (Ghoshal et al., IMC 2023).'
  },
  lteFastTrain: {
    name: 'lte-fast-train',
    describes: 'LTE on a high-speed train',
    shape: shape(
      {
        delayMs: 75,
        jitterMs: 30,
        jitterDistribution: paretonormal,
        loss: { kind: 'bursty', enterBadPercent: 0.5, leaveBadPercent: 30 }
      },
      [5000, 2000],
      [450, 180]
    ),
    outages: { everySeconds: 80, forSeconds: 2 },
    basis:
      'Measured at 350 km/h: median RTT 149 ms, mean loss 1.38%, median goodput 5 Mbit/s, a handover every 8.6-13.7 s (Wang et al., 2019); 10.6-12.5% of handovers fail (Li et al., SIGCOMM 2020). Uplink rate, burst length and the outage cycle are estimated from those.'
  },
  subway: {
    name: 'subway',
    describes: 'Subway with coverage at stations only',
    shape: shape(
      {
        delayMs: 50,
        jitterMs: 20,
        jitterDistribution: paretonormal,
        loss: { kind: 'bursty', enterBadPercent: 0.3, leaveBadPercent: 20 }
      },
      [1200, 500],
      [110, 50]
    ),
    outages: { everySeconds: 120, forSeconds: 30 },
    basis:
      'Downlink rate measured in tunnels: 1.1-1.4 Mbit/s (Wang et al., MobiCom 2026). Delay, loss and tunnel outage lengths are estimated; the only large study reports video stalls (mean 9 s, max 252 s), not link outages.'
  },
  hotelWifi: {
    name: 'hotel-wifi',
    describes: 'Congested shared Wi-Fi with a deep queue',
    shape: shape(
      {
        delayMs: 25,
        jitterMs: 40,
        jitterDistribution: 'pareto',
        loss: { kind: 'bursty', enterBadPercent: 1, leaveBadPercent: 25 }
      },
      [3000, 1000],
      [260, 90]
    ),
    basis:
      'Estimated throughout. No measurement of hotel, cafe or airport Wi-Fi was found; anchored on the worst campus access points (Pei et al., 2016) and a saturated-AP testbed (Hoiland-Jorgensen et al., ATC 2017).'
  },
  inflightGeo: {
    name: 'inflight-geo',
    describes: 'In-flight Wi-Fi over a geostationary satellite',
    shape: shape(
      {
        delayMs: 350,
        jitterMs: 100,
        jitterDistribution: paretonormal,
        loss: { kind: 'bursty', enterBadPercent: 0.4, leaveBadPercent: 20 }
      },
      [5900, 3900],
      [700, 460]
    ),
    basis:
      'Measured: RTT over 550 ms in more than 99% of 949 in-flight tests, median rates 5.9/3.9 Mbit/s (Jang et al., IMC 2025); provider medians 667-839 ms (Ookla, 2025). Jitter and loss are estimated: the last published loss figure is 9.4% from 2015-16 (Rula et al., WWW 2018).'
  },
  inflightLeo: {
    name: 'inflight-leo',
    describes: 'In-flight Wi-Fi over Starlink',
    shape: shape(
      { delayMs: 22, jitterMs: 6, loss: { kind: 'random', percent: 0.4 } },
      [85_000, 46_000],
      [1000, 600]
    ),
    outages: { everySeconds: 15, forSeconds: 0.1 },
    basis:
      'Measured: in-flight median RTT 30-54 ms and rates 85/46 Mbit/s (Jang et al., IMC 2025); loss under 0.6% (Ullah et al., 2025 preprint); a latency shift every 15 s (Tanveer et al., 2023). Treating each shift as a 100 ms cut is a simplification.'
  },
  roamingWeakSignal: {
    name: 'roaming-weak-signal',
    describes: 'Roaming abroad on a weak signal',
    shape: shape(
      {
        delayMs: 195,
        jitterMs: 40,
        jitterDistribution: paretonormal,
        loss: { kind: 'bursty', enterBadPercent: 1, leaveBadPercent: 20 }
      },
      [2000, 500],
      [230, 60]
    ),
    outages: { everySeconds: 60, forSeconds: 1 },
    basis:
      'Measured: median RTT 389 ms on a home-routed travel eSIM (Jang et al., 2024 preprint); fallback handovers take about 0.4-1 s (Kalntis et al., 2024). Loss, rates and outage frequency are estimated.'
  }
} satisfies Record<string, NetworkTravelProfile>

/**
 * Puts a path under a profile: its shape and, if it has them, its timed outages. Shaping alone
 * would give the subway's slow link without its tunnels. Call the returned function to stop the
 * outages; the shape stays until the path is reshaped or stopped.
 */
export function applyNetworkTravelProfile(
  path: ImpairedNetworkPath,
  profile: NetworkTravelProfile,
  onOutage?: (startedAtMs: number, endedAtMs: number) => void
): () => Promise<void> {
  shapeImpairedNetwork(path, profile.shape)
  if (!profile.outages) {
    return async () => {}
  }
  return scheduleNetworkOutages(path, profile.shape, profile.outages, onOutage)
}
