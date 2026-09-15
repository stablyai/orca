import {beforeEach,expect,it,vi} from 'vitest'
import {makePaneKey} from '../../src/shared/stable-pane-id'
import {toWebTerminalSurfaceTabId} from '../../src/shared/terminal-surface-id'
import {applyWebSessionTabsSnapshot} from '../../src/renderer/src/runtime/web-session-tabs-sync'
import {setHostSessionTabIdMapping} from '../../src/renderer/src/runtime/web-session-tabs-sync/tracking-mappings'
import {makeState,makeSnapshot,NOW,LEAF_ID,SECOND_LEAF_ID,resetWebSessionTabsSyncTestState} from '../../src/renderer/src/runtime/web-session-tabs-sync-test-harness'
vi.mock('../../src/renderer/src/store',()=>({useAppStore:{setState:vi.fn()}}))
beforeEach(resetWebSessionTabsSyncTestState)
function snapshot(worktreeId:string,leafId:string){return makeSnapshot([{type:'terminal',id:`same-host-tab::${leafId}`,parentTabId:'same-host-tab',leafId,title:'OMP',isActive:false,status:'ready',terminal:`term-${leafId}`,agentStatus:{paneKey:makePaneKey('same-host-tab',leafId),tabId:'same-host-tab',worktreeId,agentType:'omp',state:'working',prompt:'running',updatedAt:NOW,stateStartedAt:NOW,stateHistory:[]}}],{worktree:worktreeId})}
it.each(['folder:same','folder:other'])('does not erase a different environment sharing a host tab ID (%s)',otherWorktree=>{
 const initial=makeState();const a=applyWebSessionTabsSnapshot(initial,snapshot('folder:same',LEAF_ID),'host-a',NOW);const b=applyWebSessionTabsSnapshot(initial,snapshot(otherWorktree,SECOND_LEAF_ID),'host-b',NOW);
 const state=makeState({agentStatusByPaneKey:{...a.agentStatusByPaneKey,...b.agentStatusByPaneKey}});
 setHostSessionTabIdMapping({environmentId:'host-b',worktreeId:'folder:same',tabId:'same-host-tab'},'same-host-tab');
 const sibling=makePaneKey(toWebTerminalSurfaceTabId('same-host-tab'),SECOND_LEAF_ID);
 expect(state.agentStatusByPaneKey[sibling]).toBeDefined();
 const after={...state,...applyWebSessionTabsSnapshot(state,makeSnapshot([],{worktree:'folder:same',snapshotVersion:2}),'host-a',NOW+1)};
 expect(after.agentStatusByPaneKey[sibling]).toEqual(state.agentStatusByPaneKey[sibling]);
})
