/** Project Hub data is keyed by an Orca Project, never by a disposable worktree. */
export const PROJECT_HUB_PHASES = [
  'Descubrimiento del problema', 'Investigación, stack e infraestructura',
  'Desarrollo de arquitectura', 'MVP', 'Primera validación',
  'Corrección', 'Validación final', 'Smoke test', 'Producción', 'Documentación'
] as const
export const PROJECT_HUB_STATUSES = ['backlog','ready','doing','review','blocked','done'] as const
export type HubStatus = (typeof PROJECT_HUB_STATUSES)[number]
export type HubItem = {
  id: string; title: string; type: 'story'|'task'|'bug'|'ticket'
  status: HubStatus; phase: number; source: string
  acceptance: string; description: string
}
export type HubDocument = {
  schema: 1; projectId: string; revision: number; phase: number
  blueprint: { idea: string; problem: string; users: string; success: string }
  items: HubItem[]
  architecture: { nodes: { name: string; kind: string }[]; edges: { from: string; to: string }[]; notes: string }
  approvals: { from: number; to: number; note: string; at: string }[]
  /** Evidence is explicitly user-attested; never inferred from disconnected CI. */
  qualityEvidence?: Record<string, { status: 'verified'|'not-applicable'; note: string; at: string }>
  updatedAt: string
}
export function emptyProjectHub(projectId: string): HubDocument {
  return { schema: 1, projectId, revision: 0, phase: 1,
    blueprint: { idea:'',problem:'',users:'',success:'' },
    items: [], architecture: {nodes:[],edges:[],notes:''}, approvals:[], qualityEvidence:{}, updatedAt:'' }
}
const isRecord = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x)
const str = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max
const phase = (n: unknown): n is number => Number.isInteger(n) && (n as number)>=1 && (n as number)<=10
const status = (x: unknown): x is HubStatus => PROJECT_HUB_STATUSES.some(s=>s===x)
export function isHubDocument(d: unknown): d is HubDocument {
  if (!isRecord(d) || d.schema!==1 || !str(d.projectId,500) || !d.projectId ||
    !Number.isSafeInteger(d.revision) || (d.revision as number)<0 || !phase(d.phase) ||
    !str(d.updatedAt,80) || !isRecord(d.blueprint) || !isRecord(d.architecture) ||
    !Array.isArray(d.items) || d.items.length>300 || !Array.isArray(d.approvals) || d.approvals.length>100)
    return false
  // Keep a stable narrowed reference across the array callback (TS18046).
  const blueprint = d.blueprint
  if (!['idea','problem','users','success'].every(k=>str(blueprint[k],2500))) return false
  const evidence = d.qualityEvidence
  if(evidence!==undefined) {
    if(!isRecord(evidence) || Object.keys(evidence).length>40) return false
    for(const [key,value] of Object.entries(evidence)) {
      // Do not allow a caller to preload approvals for future phases.
      if(!/^(?:[1-9]|10):(acceptance|flow|ci|owner)$/.test(key)||
        Number(key.split(':')[0])>d.phase||!isRecord(value)||
        !['verified','not-applicable'].includes(String(value.status))||
        !str(value.note,500)||value.note.trim().length<5||!str(value.at,80)) return false
    }
  }
  const a=d.architecture
  if (!Array.isArray(a.nodes) || a.nodes.length>30 || !Array.isArray(a.edges) || a.edges.length>60 || !str(a.notes,4000))
    return false
  const names=new Set<string>()
  for (const node of a.nodes) {
    if(!isRecord(node)||!str(node.name,60)||!node.name||names.has(node.name)||!str(node.kind,40)) return false
    names.add(node.name)
  }
  if (!a.edges.every(e=>isRecord(e)&&typeof e.from==='string'&&typeof e.to==='string'&&names.has(e.from)&&names.has(e.to))) return false
  const ids=new Set<string>()
  for (const item of d.items) {
    if (!isRecord(item)||!str(item.id,80)||!/^[a-zA-Z0-9_-]{2,80}$/.test(item.id)||ids.has(item.id)||
      !str(item.title,160)||!item.title.trim()||!['story','task','bug','ticket'].includes(String(item.type))||
      !status(item.status)||!phase(item.phase)||!str(item.source,120)||
      !str(item.acceptance,2000)||!str(item.description,4000)) return false
    ids.add(item.id)
  }
  let last=1
  for (const approval of d.approvals) {
    if (!isRecord(approval)||!phase(approval.from)||!phase(approval.to)||
      approval.to!==approval.from+1||approval.from!==last||
      !str(approval.note,500)||approval.note.trim().length<5||!str(approval.at,80)) return false
    last=approval.to
  }
  // An approved phase must have a complete 1→2→... chain; otherwise the
  // UI and the stored audit trail disagree about which gates were passed.
  return last===d.phase
}
export const HUB_GATE_KEYS = ['acceptance','flow','ci','owner'] as const
export function hasHubPhaseEvidence(doc: HubDocument): boolean {
  return HUB_GATE_KEYS.every(key=>{
    const value=doc.qualityEvidence?.[doc.phase+':'+key]
    return value && (value.status==='verified'||value.status==='not-applicable') &&
      value.note.trim().length>=5
  })
}
export function approveHubPhase(doc: HubDocument, note: string, at: string): HubDocument {
  if (doc.phase>=10) throw new Error('La fase 10 es la última.')
  if (!hasHubPhaseEvidence(doc)) throw new Error('Faltan evidencias manuales de QA para esta fase.')
  if (note.trim().length<5 || note.length>500) throw new Error('La aprobación requiere al menos cinco caracteres.')
  if (!/^\d{4}-\d\d-\d\dT/.test(at)) throw new Error('Fecha inválida.')
  return {...doc, phase:doc.phase+1,
    approvals:[...doc.approvals,{from:doc.phase,to:doc.phase+1,note:note.trim(),at}]}
}
