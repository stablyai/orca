import { describe, expect, it } from 'vitest'
import { emptyProjectHub, approveHubPhase, isHubDocument, hasHubPhaseEvidence, PROJECT_HUB_PHASES } from './project-hub-types'
describe('Project Hub document contracts',()=>{
  it('has all ten phases',()=>expect(PROJECT_HUB_PHASES).toHaveLength(10))
  it('starts as a valid isolated project document',()=>{
    const doc=emptyProjectHub('github:bcuyul/orca')
    expect(isHubDocument(doc)).toBe(true)
    expect(doc.projectId).toBe('github:bcuyul/orca')
    expect(doc.phase).toBe(1)
  })
  it('requires approval and keeps the previous document intact',()=>{
    const doc=emptyProjectHub('repo:123')
    expect(()=>approveHubPhase(doc,'',new Date().toISOString())).toThrow()
    expect(()=>approveHubPhase(doc,'Validación humana',new Date().toISOString())).toThrow(/evidencias/)
    const qualityEvidence=Object.fromEntries(['acceptance','flow','ci','owner'].map(key=>[
      '1:'+key,{status:'verified' as const,note:'Evidencia manual registrada',at:new Date().toISOString()}
    ]))
    const qualified={...doc,qualityEvidence}
    expect(hasHubPhaseEvidence(qualified)).toBe(true)
    const next=approveHubPhase(qualified,'Validación humana',new Date().toISOString())
    expect(next.phase).toBe(2)
    expect(doc.phase).toBe(1)
    expect(isHubDocument(next)).toBe(true)
  })
  it('requires five non-whitespace characters for each QA note at the shared boundary',()=>{
    const base=emptyProjectHub('repo:qa-limits')
    const valid={status:'verified' as const,note:'valid',at:new Date().toISOString()}
    const key='1:ci'
    for(const note of ['',' ','abcd','  abcd  ']){
      const doc={...base,qualityEvidence:{[key]:{...valid,note}}}
      expect(isHubDocument(doc)).toBe(false)
      expect(hasHubPhaseEvidence(doc)).toBe(false)
    }
    expect(isHubDocument({...base,qualityEvidence:{[key]:valid}})).toBe(true)
    expect(isHubDocument({...base,qualityEvidence:{[key]:{...valid,note:'a'.repeat(501)}}})).toBe(false)
    expect(isHubDocument({...base,qualityEvidence:{[key]:{...valid,status:'unknown'}}})).toBe(false)
    expect(isHubDocument({...base,qualityEvidence:{[key]:{...valid,status:'not-applicable'}}})).toBe(true)
    expect(isHubDocument({...base,qualityEvidence:{'2:ci':valid}})).toBe(false)
  })
  it('requires a complete sequential audit trail and meaningful approval reason',()=>{
    const base=emptyProjectHub('repo:approval')
    const at=new Date().toISOString()
    const qualityEvidence=Object.fromEntries(['acceptance','flow','ci','owner'].map(key=>[
      '1:'+key,{status:'verified' as const,note:'Passed manually',at}
    ]))
    const ready={...base,qualityEvidence}
    expect(hasHubPhaseEvidence(ready)).toBe(true)
    expect(()=>approveHubPhase(ready,'abcd',at)).toThrow(/cinco/)
    expect(()=>approveHubPhase(ready,'   ',at)).toThrow(/cinco/)
    const approved=approveHubPhase(ready,'Human approval',at)
    expect(isHubDocument(approved)).toBe(true)
    expect(isHubDocument({...approved,approvals:[]})).toBe(false)
    expect(isHubDocument({...approved,approvals:[{...approved.approvals[0],note:'x'}]})).toBe(false)
  })
  it('rejects duplicate items, invalid phases, invalid architecture edges',()=>{
    const doc=emptyProjectHub('repo:123')
    expect(isHubDocument({...doc,phase:11})).toBe(false)
    expect(isHubDocument({...doc,architecture:{notes:'',nodes:[],edges:[{from:'A',to:'B'}]}})).toBe(false)
  })
})
