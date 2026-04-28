import { useEffect, useState } from 'react'

// Why: relative timestamps drift once mounted. A 30s tick keeps the "Xm
// ago" labels honest without burning a render every second.
//
// Hoisted to a shared hook so container components (AgentDashboard,
// AgentStatusHover) can own a single tick and thread `now` down to every
// DashboardAgentRow. Previously each row instantiated its own interval,
// which meant N timers firing at staggered mount times for N rows on
// screen — turning one logical tick into N independent React commits.
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}
