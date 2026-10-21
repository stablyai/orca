/** GJC (gajae-code) is an OMP fork that loads Orca's OMP status extension from
 *  `~/.gjc/agent/extensions`. It keeps OMP's event, approval and session semantics,
 *  but reports through `/hook/gjc` so its rows carry their own label and icon. */
export type OmpFamilyAgent = 'omp' | 'gjc'

export function isOmpFamilyAgent(agent: unknown): agent is OmpFamilyAgent {
  return agent === 'omp' || agent === 'gjc'
}
